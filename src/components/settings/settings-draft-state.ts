export type SettingsResourceKind = "workspace" | "project";

export function rebaseSettingsDraft(
  baselineName: string,
  draftName: string,
  remoteName: string
): { baselineName: string; draftName: string; conflicted: boolean } {
  const localChanged = normalizeName(draftName) !== baselineName;
  const remoteChanged = remoteName !== baselineName;
  return {
    baselineName: remoteName,
    draftName: localChanged ? draftName : remoteName,
    conflicted: localChanged && remoteChanged && normalizeName(draftName) !== remoteName
  };
}

export function settingsDraftUpdateInput(
  baselineName: string,
  draftName: string
): { name: string; expectedName: string } {
  return { name: draftName, expectedName: baselineName };
}

export function settingsDraftStorageKey(
  actorId: string,
  resourceKind: SettingsResourceKind,
  resourceId: string
): string {
  return `agentsmith:settings-draft:${actorId}:${resourceKind}:${resourceId}`;
}

export function encodeSettingsDraft(input: {
  actorId: string;
  resourceKind: SettingsResourceKind;
  resourceId: string;
  baselineName: string;
  name: string;
}): string {
  return JSON.stringify({ version: 1, ...input });
}

export function decodeSettingsDraft(
  encoded: string | null,
  expected: {
    actorId: string;
    resourceKind: SettingsResourceKind;
    resourceId: string;
  }
): { baselineName: string; name: string } | null {
  if (!encoded) return null;
  try {
    const value: unknown = JSON.parse(encoded);
    if (!isRecord(value)
      || value.version !== 1
      || value.actorId !== expected.actorId
      || value.resourceKind !== expected.resourceKind
      || value.resourceId !== expected.resourceId
      || typeof value.baselineName !== "string"
      || value.baselineName.length > 160
      || typeof value.name !== "string"
      || value.name.length > 160) {
      return null;
    }
    return { baselineName: value.baselineName, name: value.name };
  } catch {
    return null;
  }
}

function normalizeName(name: string): string {
  return name.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
