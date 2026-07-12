import type { ProjectMember } from "../../lib/api/client.js";

export function memberMatchesQuery(member: ProjectMember, query: string): boolean {
  const term = query.trim().toLowerCase();
  return [member.displayName, member.email, member.userId].some((value) => value?.toLowerCase().includes(term));
}

export function memberIdentityLabel(member: Pick<ProjectMember, "displayName" | "email" | "userId">): string { return member.displayName || member.email || member.userId; }

export function memberRoleLabel(role: ProjectMember["role"]): string {
  return role === "owner" ? "Owner" : role.charAt(0).toUpperCase() + role.slice(1);
}

export function applyMemberSave(members: ProjectMember[], saved: ProjectMember): ProjectMember[] {
  const existing = members.some((member) => member.userId === saved.userId);
  return existing ? members.map((member) => member.userId === saved.userId ? saved : member) : [...members, saved];
}

export function removeMemberById(members: ProjectMember[], userId: string): ProjectMember[] {
  return members.filter((member) => member.userId !== userId);
}
