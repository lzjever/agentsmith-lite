import type { ManagedWorkspaceMembershipRole, StoredUser, WorkspaceMembershipView } from "../../contracts/src/api.js";
import { NotFoundError, ProductError } from "../../domain/src/errors.js";
import { nowIso } from "../../domain/src/ids.js";
import type { ProductStore } from "../../ports/src/store.js";
import { AuthorizationService } from "./authorizationService.js";

type Identity = { email?: string; issuer?: string; subject?: string };

export class WorkspaceMembershipService {
  constructor(private readonly store: ProductStore, private readonly authorization: AuthorizationService) {}
  async list(actor:string,workspaceId:string){await this.authorization.requireWorkspace(actor,workspaceId);return this.store.listWorkspaceMemberships(workspaceId)}
  async add(actor:string,workspaceId:string,identity:Identity,role:ManagedWorkspaceMembershipRole){await this.authorization.requireWorkspace(actor,workspaceId,"admin");const user=await this.find(identity);const timestamp=nowIso();const created=await this.store.createWorkspaceMembership({workspaceId,userId:user.id,role,createdAt:timestamp,updatedAt:timestamp});if(created==="already_exists")throw new ProductError("Workspace membership already exists",409);return this.view(workspaceId,user.id)}
  async change(actor:string,workspaceId:string,userId:string,role:ManagedWorkspaceMembershipRole){await this.authorization.requireWorkspace(actor,workspaceId,"admin");const result=await this.store.updateManagedWorkspaceMembershipRole(workspaceId,userId,role,nowIso());if(result==="not_found")throw new NotFoundError("Workspace membership not found");if(result==="owner")throw new ProductError("Workspace owner membership cannot be changed or removed",409);return this.view(workspaceId,userId)}
  async remove(actor:string,workspaceId:string,userId:string){await this.authorization.requireWorkspace(actor,workspaceId,"admin");const result=await this.store.revokeWorkspaceMembership(workspaceId,userId);if(result==="not_found")throw new NotFoundError("Workspace membership not found");if(result==="owner")throw new ProductError("Workspace or project owner membership cannot be removed",409)}
  async transferOwner(actor:string,workspaceId:string,targetUserId:string){const workspace=await this.authorization.requireWorkspace(actor,workspaceId,"admin");if(workspace.ownerUserId!==actor)throw new ProductError("Workspace owner access required",403);if(!(await this.store.transferWorkspaceOwner(workspaceId,actor,targetUserId.trim(),nowIso())))throw new ProductError("Target must be a different existing workspace member",409)}
  private async view(workspaceId:string,userId:string):Promise<WorkspaceMembershipView>{const member=(await this.store.listWorkspaceMemberships(workspaceId)).find((candidate)=>candidate.userId===userId);if(!member)throw new NotFoundError("Workspace membership not found");return member}
  private async find(identity:Identity):Promise<StoredUser>{const email=identity.email?.trim().toLowerCase();const issuer=identity.issuer?.trim();const subject=identity.subject?.trim();if((email&&(issuer||subject))||(!email&&!(issuer&&subject)))throw new ProductError("Specify either a verified email or an OIDC issuer and subject");const user=email?await this.store.findVerifiedUserByEmail(email):await this.store.findUserByOidcSubject(issuer!,subject!);if(!user?.emailVerified)throw new NotFoundError("Verified identity not found");return user}
}
