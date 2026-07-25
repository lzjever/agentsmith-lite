import type { Profile, ProfileGreetingPreference } from "../../lib/api/client.js";

export const unsetProfileGreeting = "unset" as const;
export const profileGreetings = ["formal", "casual", "friendly", "professional"] as const satisfies readonly ProfileGreetingPreference[];

export type ProfileDraft = {
  displayName: string;
  timezone: string;
  bio: string;
  jobTitle: string;
  company: string;
  greeting: ProfileGreetingPreference | typeof unsetProfileGreeting;
  interests: string;
};

type ProfileDraftField = keyof ProfileDraft;
type ProfilePatch = {
  displayName?: string | null;
  timezone?: string | null;
  bio?: string | null;
  jobTitle?: string | null;
  company?: string | null;
  greetingPreference?: ProfileGreetingPreference | null;
  interests?: string[];
  expectedUpdatedAt: string;
};

const fields: readonly ProfileDraftField[] = [
  "displayName",
  "timezone",
  "bio",
  "jobTitle",
  "company",
  "greeting",
  "interests"
];

const fieldLabels: Record<ProfileDraftField, string> = {
  displayName: "Display name",
  timezone: "Timezone",
  bio: "Bio",
  jobTitle: "Job title",
  company: "Company",
  greeting: "Greeting style",
  interests: "Interests"
};

export function emptyProfileDraft(): ProfileDraft {
  return {
    displayName: "",
    timezone: "",
    bio: "",
    jobTitle: "",
    company: "",
    greeting: unsetProfileGreeting,
    interests: ""
  };
}

export function profileDraftFromProfile(profile: Profile): ProfileDraft {
  const greeting = profile.preferences.greetingPreference;
  return {
    displayName: profile.preferences.displayName ?? "",
    timezone: profile.preferences.timezone ?? "",
    bio: profile.preferences.bio ?? "",
    jobTitle: profile.preferences.jobTitle ?? "",
    company: profile.preferences.company ?? "",
    greeting: greeting && profileGreetings.includes(greeting) ? greeting : unsetProfileGreeting,
    interests: profile.preferences.interests.join(", ")
  };
}

export function profileDraftPatch(
  baseline: ProfileDraft,
  draft: ProfileDraft,
  expectedUpdatedAt: string
): ProfilePatch {
  const patch: ProfilePatch = { expectedUpdatedAt };
  if (!sameField("displayName", baseline, draft)) patch.displayName = optionalText(draft.displayName);
  if (!sameField("timezone", baseline, draft)) patch.timezone = optionalText(draft.timezone);
  if (!sameField("bio", baseline, draft)) patch.bio = optionalText(draft.bio);
  if (!sameField("jobTitle", baseline, draft)) patch.jobTitle = optionalText(draft.jobTitle);
  if (!sameField("company", baseline, draft)) patch.company = optionalText(draft.company);
  if (!sameField("greeting", baseline, draft)) {
    patch.greetingPreference = draft.greeting === unsetProfileGreeting ? null : draft.greeting;
  }
  if (!sameField("interests", baseline, draft)) patch.interests = parseProfileInterests(draft.interests);
  return patch;
}

export function isProfileDraftDirty(baseline: ProfileDraft, draft: ProfileDraft): boolean {
  return fields.some((field) => !sameField(field, baseline, draft));
}

export function rebaseProfileDraft(
  baseline: ProfileDraft,
  local: ProfileDraft,
  remote: ProfileDraft
): { draft: ProfileDraft; conflicts: string[] } {
  const draft = { ...remote };
  const conflicts: string[] = [];
  for (const field of fields) {
    const localChanged = !sameFieldValue(field, local[field], baseline[field]);
    if (!localChanged) continue;
    draft[field] = local[field] as never;
    const remoteChanged = !sameFieldValue(field, remote[field], baseline[field]);
    if (remoteChanged && !sameFieldValue(field, local[field], remote[field])) {
      conflicts.push(fieldLabels[field]);
    }
  }
  return { draft, conflicts };
}

export function parseProfileInterests(value: string): string[] {
  return [...new Set(value.split(",").map((interest) => interest.trim()).filter(Boolean))];
}

export function profileDraftStorageKey(actorId: string): string {
  return `agentsmith:profile-draft:${actorId}`;
}

export function encodeProfileDraft(input: {
  actorId: string;
  resourceId: string;
  baseline: ProfileDraft;
  draft: ProfileDraft;
}): string {
  return JSON.stringify({ version: 1, ...input });
}

export function decodeProfileDraft(
  encoded: string | null,
  expected: { actorId: string; resourceId: string }
): { baseline: ProfileDraft; draft: ProfileDraft } | null {
  if (!encoded) return null;
  try {
    const value: unknown = JSON.parse(encoded);
    if (!isRecord(value)
      || value.version !== 1
      || value.actorId !== expected.actorId
      || value.resourceId !== expected.resourceId
      || !isProfileDraft(value.baseline)
      || !isProfileDraft(value.draft)) {
      return null;
    }
    return { baseline: value.baseline, draft: value.draft };
  } catch {
    return null;
  }
}

function sameField(field: ProfileDraftField, left: ProfileDraft, right: ProfileDraft): boolean {
  return sameFieldValue(field, left[field], right[field]);
}

function sameFieldValue(field: ProfileDraftField, left: string, right: string): boolean {
  if (field === "interests") {
    return JSON.stringify(parseProfileInterests(left)) === JSON.stringify(parseProfileInterests(right));
  }
  if (field === "greeting") return left === right;
  return optionalText(left) === optionalText(right);
}

function optionalText(value: string): string | null {
  return value.trim() || null;
}

function isProfileDraft(value: unknown): value is ProfileDraft {
  if (!isRecord(value)) return false;
  return isBoundedString(value.displayName, 120)
    && isBoundedString(value.timezone, 120)
    && isBoundedString(value.bio, 1_000)
    && isBoundedString(value.jobTitle, 120)
    && isBoundedString(value.company, 120)
    && isValidInterestsDraft(value.interests)
    && (value.greeting === unsetProfileGreeting
      || profileGreetings.includes(value.greeting as ProfileGreetingPreference));
}

function isValidInterestsDraft(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1_240) return false;
  const interests = parseProfileInterests(value);
  return interests.length <= 20 && interests.every((interest) => interest.length <= 60);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
