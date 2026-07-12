import type { ProfileResponse, ProfileUser, StoredUser, UserProfilePreferences } from "../../contracts/src/api.js";
import { nowIso } from "../../domain/src/ids.js";
import type { ProductStore } from "../../ports/src/store.js";

export class ProfileService {
  constructor(private readonly store: ProductStore) {}

  async getProfile(userId: string): Promise<ProfileResponse> {
    const user = await this.requireUser(userId);
    const preferences = await this.store.findUserProfilePreferences(userId)
      ?? emptyPreferences(userId, user.updatedAt);
    return { user: publicUser(user), preferences };
  }

  async updateProfile(userId: string, input: { displayName?: unknown; timezone?: unknown; bio?: unknown; jobTitle?: unknown; company?: unknown; greetingPreference?: unknown; interests?: unknown }): Promise<ProfileResponse> {
    const user = await this.requireUser(userId);
    const previous = await this.store.findUserProfilePreferences(userId);
    const preferences = await this.store.upsertUserProfilePreferences({
      userId,
      displayName: optionalText(input.displayName, "profile.displayName", previous?.displayName ?? null),
      timezone: optionalText(input.timezone, "profile.timezone", previous?.timezone ?? null),
      bio: optionalText(input.bio, "profile.bio", previous?.bio ?? null, 1_000),
      jobTitle: optionalText(input.jobTitle, "profile.jobTitle", previous?.jobTitle ?? null),
      company: optionalText(input.company, "profile.company", previous?.company ?? null),
      greetingPreference: optionalText(input.greetingPreference, "profile.greetingPreference", previous?.greetingPreference ?? null),
      interests: optionalInterests(input.interests, previous?.interests ?? []),
      updatedAt: nowIso()
    });
    return { user: publicUser(user), preferences };
  }

  private async requireUser(userId: string) {
    const user = await this.store.findUserById(userId);
    if (!user) throw new Error("Authenticated user was not found");
    return user;
  }
}

function optionalText(value: unknown, field: string, fallback: string | null, max = 120): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field} must be ${max} characters or less`);
  return trimmed || null;
}
function optionalInterests(value: unknown, fallback: string[]): string[] { if(value===undefined)return fallback;if(!Array.isArray(value)||value.length>20||value.some((item)=>typeof item!=="string"||item.trim().length===0||item.trim().length>60))throw new Error("profile.interests must be up to 20 English text values"); return [...new Set(value.map((item)=>item.trim()))]; }
function emptyPreferences(userId:string,updatedAt:string):UserProfilePreferences{return{userId,displayName:null,timezone:null,bio:null,jobTitle:null,company:null,greetingPreference:null,interests:[],updatedAt}}

function publicUser(user: StoredUser): ProfileUser {
  const { id, email, pictureUrl, emailVerified, createdAt, updatedAt } = user;
  return { id, email, ...(pictureUrl ? { pictureUrl } : {}), emailVerified, createdAt, updatedAt };
}
