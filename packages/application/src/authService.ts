import { createHash, scrypt as scryptCallback, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AuthSession, PublicUser, StoredUser } from "../../contracts/src/api.js";
import { ForbiddenError, UnauthorizedError } from "../../domain/src/errors.js";
import { nowIso } from "../../domain/src/ids.js";
import type { ProductStore } from "../../ports/src/store.js";

const scrypt = promisify(scryptCallback);
const BUILTIN_ADMIN_ID = "user_builtin_admin";
const BUILTIN_ADMIN_EMAIL = "admin@agentsmith-lite.local";

export interface LoginResult {
  user: PublicUser;
  sessionId: string;
  csrfToken: string;
  expiresAt: string;
}

export interface SessionPrincipal {
  user: PublicUser;
  csrfToken: string;
}

export interface ExternalPrincipal {
  issuer: string;
  subject: string;
  email: string;
  emailVerified?: boolean;
  pictureUrl?: string;
  idToken?: string;
}

export class AuthService {
  constructor(
    private readonly store: ProductStore,
    private readonly builtinAdminPassword: string,
    private readonly sessionSecret: string
  ) {}

  async bootstrapBuiltInAdmin(): Promise<{ created: boolean; user: PublicUser }> {
    const existing = await this.store.findUserById(BUILTIN_ADMIN_ID);
    if (existing) {
      return { created: false, user: publicUser(existing) };
    }
    const timestamp = nowIso();
    const user: StoredUser = {
      id: BUILTIN_ADMIN_ID,
      email: BUILTIN_ADMIN_EMAIL,
      emailVerified: false,
      passwordHash: await hashPassword(this.builtinAdminPassword),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return { created: true, user: await this.store.createUser(user) };
  }

  async loginAfterBootstrap(password: string): Promise<LoginResult> {
    await this.bootstrapBuiltInAdmin();
    return this.login(BUILTIN_ADMIN_EMAIL, password);
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.store.findUserByEmail(email);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedError("Invalid email or password");
    }
    const session = await this.createSession(user.id);
    return {
      user: publicUser(user),
      sessionId: session.id,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt
    };
  }

  async loginExternalPrincipal(principal: ExternalPrincipal): Promise<LoginResult> {
    const userId = externalUserId(principal);
    requireVerifiedExternalEmail(principal);
    const existing = await this.store.findUserByOidcSubject(principal.issuer, principal.subject);
    const storedUser = existing
      ? await this.updateExternalIdentity(existing, principal)
      : await this.resolveExternalUser(userId, principal);
    const session = await this.createSession(storedUser.id, principal.idToken);
    return {
      user: publicUser(storedUser),
      sessionId: session.id,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt
    };
  }

  async hasAnyUser(): Promise<boolean> {
    return (await this.store.countUsers()) > 0;
  }

  async requireSession(sessionId: string | null): Promise<PublicUser> {
    return (await this.requireSessionPrincipal(sessionId)).user;
  }

  async requireSessionPrincipal(sessionId: string | null): Promise<SessionPrincipal> {
    if (!sessionId) {
      throw new UnauthorizedError();
    }
    const session = await this.store.findSession(sessionId);
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
      throw new UnauthorizedError();
    }
    const user = await this.store.findUserById(session.userId);
    if (!user) {
      throw new UnauthorizedError();
    }
    return {
      user: publicUser(user),
      csrfToken: session.csrfToken
    };
  }

  async requireCsrf(sessionId: string | null, csrfToken: string | null): Promise<void> {
    if (!sessionId || !csrfToken) {
      throw new ForbiddenError("CSRF token is required");
    }
    const session = await this.store.findSession(sessionId);
    if (!session || session.csrfToken !== csrfToken) {
      throw new ForbiddenError("Invalid CSRF token");
    }
  }

  async logout(sessionId: string | null): Promise<{ idTokenHint?: string }> {
    if (!sessionId) {
      throw new UnauthorizedError();
    }
    const session = await this.store.findSession(sessionId);
    if (!session) {
      throw new UnauthorizedError();
    }
    await this.store.deleteSession(sessionId);
    return session.oidcIdToken ? { idTokenHint: session.oidcIdToken } : {};
  }

  private async createSession(userId: string, oidcIdToken?: string): Promise<AuthSession> {
    const created = new Date();
    const expires = new Date(created.getTime() + 1000 * 60 * 60 * 12);
    return this.store.createSession({
      id: `sess_${randomBytes(18).toString("hex")}`,
      userId,
      csrfToken: `csrf_${randomBytes(18).toString("hex")}`,
      ...(oidcIdToken ? { oidcIdToken } : {}),
      createdAt: created.toISOString(),
      expiresAt: expires.toISOString()
    });
  }

  getSessionSecretFingerprint(): string {
    return `sha256:${Buffer.from(this.sessionSecret).toString("base64url").slice(0, 12)}`;
  }

  private async createExternalUser(userId: string, principal: ExternalPrincipal): Promise<StoredUser> {
    const timestamp = nowIso();
    const user: StoredUser = {
      id: userId,
      email: externalEmail(principal),
      oidcIssuer: requireExternalPrincipalField(principal.issuer, "issuer"),
      oidcSubject: requireExternalPrincipalField(principal.subject, "subject"),
      emailVerified: true,
      ...(safePictureUrl(principal.pictureUrl) ? { pictureUrl: safePictureUrl(principal.pictureUrl)! } : {}),
      passwordHash: "external:oidc",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.store.createUser(user);
    return user;
  }

  private async resolveExternalUser(userId: string, principal: ExternalPrincipal): Promise<StoredUser> {
    let bound: StoredUser | null;
    try {
      bound = await this.store.bindLegacyExternalIdentity({
        userId,
        issuer: requireExternalPrincipalField(principal.issuer, "issuer"),
        subject: requireExternalPrincipalField(principal.subject, "subject"),
        email: externalEmail(principal),
        updatedAt: nowIso()
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const concurrentlyBound = await this.store.findUserByOidcSubject(principal.issuer, principal.subject);
      if (concurrentlyBound) {
        return this.updateExternalIdentity(concurrentlyBound, principal);
      }
      throw new UnauthorizedError("OIDC identity does not match the existing user");
    }
    if (bound) {
      return bound;
    }

    const concurrentlyBound = await this.store.findUserByOidcSubject(principal.issuer, principal.subject);
    if (concurrentlyBound) {
      return this.updateExternalIdentity(concurrentlyBound, principal);
    }
    if (await this.store.findUserById(userId)) {
      throw new UnauthorizedError("OIDC identity does not match the existing user");
    }

    try {
      return await this.createExternalUser(userId, principal);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const createdConcurrently = await this.store.findUserByOidcSubject(principal.issuer, principal.subject);
      if (createdConcurrently) {
        return this.updateExternalIdentity(createdConcurrently, principal);
      }
      throw new UnauthorizedError("OIDC identity does not match the existing user");
    }
  }

  private async updateExternalIdentity(user: StoredUser, principal: ExternalPrincipal): Promise<StoredUser> {
    const email = externalEmail(principal);
    const pictureUrl = safePictureUrl(principal.pictureUrl);
    if (user.email === email && user.emailVerified && user.oidcIssuer === principal.issuer && user.oidcSubject === principal.subject && user.pictureUrl === pictureUrl) {
      return user;
    }
    const emailOwner = await this.store.findUserByEmail(email);
    if (emailOwner && emailOwner.id !== user.id) {
      throw new UnauthorizedError("OIDC identity could not be authenticated");
    }
    const { pictureUrl: _previousPictureUrl, ...userWithoutPicture } = user;
    const updated = {
      ...userWithoutPicture,
      email,
      oidcIssuer: principal.issuer,
      oidcSubject: principal.subject,
      emailVerified: true,
      ...(pictureUrl ? { pictureUrl } : {}),
      updatedAt: nowIso()
    };
    try {
      await this.store.updateUser(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new UnauthorizedError("OIDC identity could not be authenticated");
      }
      throw error;
    }
    return updated;
  }

}

async function hashPassword(password: string, salt = randomBytes(16).toString("hex")): Promise<string> {
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) {
    return false;
  }
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function publicUser(user: StoredUser): PublicUser {
  const { passwordHash: _passwordHash, oidcIssuer: _issuer, oidcSubject: _subject, ...publicFields } = user;
  return structuredClone(publicFields);
}

function safePictureUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try { const parsed = new URL(value.trim()); return parsed.protocol === "https:" ? parsed.toString() : undefined; } catch { return undefined; }
}

function externalUserId(principal: ExternalPrincipal): string {
  const issuer = requireExternalPrincipalField(principal.issuer, "issuer");
  const subject = requireExternalPrincipalField(principal.subject, "subject");
  const digest = createHash("sha256").update(`${issuer}\0${subject}`).digest("hex").slice(0, 32);
  return `user_oidc_${digest}`;
}

function externalEmail(principal: ExternalPrincipal): string {
  const email = normalizeEmail(principal.email);
  if (!email) {
    throw new UnauthorizedError("OIDC principal email is required");
  }
  return email;
}

function requireVerifiedExternalEmail(principal: ExternalPrincipal): void {
  externalEmail(principal);
  if (principal.emailVerified !== true) {
    throw new UnauthorizedError("OIDC principal email must be verified");
  }
}

function normalizeEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  return email || undefined;
}

function requireExternalPrincipalField(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new UnauthorizedError(`OIDC principal ${name} is required`);
  }
  return trimmed;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
