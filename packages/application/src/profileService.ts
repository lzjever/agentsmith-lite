import { PROFILE_GREETING_PREFERENCES, type ProfileGreetingPreference, type ProfileResponse, type ProfileUser, type StoredUser, type UserProfilePreferences } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
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
      greetingPreference: optionalGreetingPreference(input.greetingPreference, previous?.greetingPreference ?? null),
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
  if (typeof value !== "string") throw new ProductError(`${field} must be a string or null`, 400);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ProductError(`${field} must be ${max} characters or less`, 400);
  return trimmed || null;
}
function optionalInterests(value: unknown, fallback: string[]): string[] { if(value===undefined)return fallback;if(!Array.isArray(value)||value.length>20||value.some((item)=>typeof item!=="string"||item.trim().length===0||item.trim().length>60))throw new ProductError("profile.interests must be up to 20 text values of 60 characters or less",400); return [...new Set(value.map((item)=>item.trim()))]; }
function optionalGreetingPreference(value: unknown, fallback: ProfileGreetingPreference | null): ProfileGreetingPreference | null { if(value===undefined)return fallback;if(value===null)return null;if(typeof value!=="string"||!PROFILE_GREETING_PREFERENCES.includes(value as ProfileGreetingPreference))throw new ProductError("profile.greetingPreference is invalid",400);return value as ProfileGreetingPreference; }
function emptyPreferences(userId:string,updatedAt:string):UserProfilePreferences{return{userId,displayName:null,timezone:null,bio:null,jobTitle:null,company:null,greetingPreference:null,interests:[],updatedAt}}

function publicUser(user: StoredUser): ProfileUser {
  const { id, email, pictureUrl, emailVerified, createdAt, updatedAt } = user;
  return { id, email, ...(pictureUrl ? { pictureUrl } : {}), emailVerified, createdAt, updatedAt };
}
