import type { ProjectMember } from "../../lib/api/client.js";

export function memberIdentityLabel(member: Pick<ProjectMember, "displayName" | "email" | "userId">): string { return member.displayName || member.email || member.userId; }

export function memberRoleLabel(role: ProjectMember["role"]): string {
  return role === "owner" ? "Owner" : role.charAt(0).toUpperCase() + role.slice(1);
}
