export function auditResourceIdentity(resourceKind: string, resourceId: string | null): string {
  if (resourceId) return resourceId;
  return resourceKind === "provider" ? "Project-level provider activity" : "-";
}
