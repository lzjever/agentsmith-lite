import { createHash, scrypt as scryptCallback, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AuthSession, StoredUser, User, UserRole } from "../../contracts/src/api.js";
import { ForbiddenError, UnauthorizedError } from "../../domain/src/errors.js";
import { nowIso } from "../../domain/src/ids.js";
import type { ProductStore } from "../../ports/src/store.js";

const scrypt = promisify(scryptCallback);
const BUILTIN_ADMIN_ID = "user_builtin_admin";
const BUILTIN_ADMIN_EMAIL = "admin@agentsmith-lite.local";

export interface LoginResult {
  user: User;
  sessionId: string;
  csrfToken: string;
  expiresAt: string;
}

export interface SessionPrincipal {
  user: User;
  csrfToken: string;
}

export interface ExternalPrincipal {
  issuer: string;
  subject: string;
  email?: string | undefined;
}

export interface OidcAdminAllowlist {
  emails?: readonly string[];
  subjects?: readonly string[];
}

export class AuthService {
  private readonly oidcAdminEmails: Set<string>;
  private readonly oidcAdminSubjects: Set<string>;

  constructor(
    private readonly store: ProductStore,
    private readonly builtinAdminPassword: string,
    private readonly sessionSecret: string,
    oidcAdminAllowlist: OidcAdminAllowlist = {}
  ) {
    this.oidcAdminEmails = new Set((oidcAdminAllowlist.emails ?? []).flatMap((email) => {
      const normalized = normalizeEmail(email);
      return normalized ? [normalized] : [];
    }));
    this.oidcAdminSubjects = new Set((oidcAdminAllowlist.subjects ?? []).flatMap((subject) => {
      const trimmed = subject.trim();
      return trimmed ? [trimmed] : [];
    }));
  }

  async bootstrapBuiltInAdmin(): Promise<{ created: boolean; user: User }> {
    const existing = await this.store.findUserById(BUILTIN_ADMIN_ID);
    if (existing) {
      return { created: false, user: publicUser(existing) };
    }
    const timestamp = nowIso();
    const user: StoredUser = {
      id: BUILTIN_ADMIN_ID,
      email: BUILTIN_ADMIN_EMAIL,
      role: "admin",
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
    const role = this.roleForExternalPrincipal(principal);
    const existing = await this.store.findUserById(userId);
    const storedUser = existing ? await this.ensureExternalUserRole(existing, role) : await this.createExternalUser(userId, principal, role);
    const session = await this.createSession(userId);
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

  async requireSession(sessionId: string | null): Promise<User> {
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

  async logout(sessionId: string | null): Promise<void> {
    if (!sessionId) {
      throw new UnauthorizedError();
    }
    await this.store.deleteSession(sessionId);
  }

  private async createSession(userId: string): Promise<AuthSession> {
    const created = new Date();
    const expires = new Date(created.getTime() + 1000 * 60 * 60 * 12);
    return this.store.createSession({
      id: `sess_${randomBytes(18).toString("hex")}`,
      userId,
      csrfToken: `csrf_${randomBytes(18).toString("hex")}`,
      createdAt: created.toISOString(),
      expiresAt: expires.toISOString()
    });
  }

  getSessionSecretFingerprint(): string {
    return `sha256:${Buffer.from(this.sessionSecret).toString("base64url").slice(0, 12)}`;
  }

  private async createExternalUser(userId: string, principal: ExternalPrincipal, role: UserRole): Promise<StoredUser> {
    const timestamp = nowIso();
    const user: StoredUser = {
      id: userId,
      email: externalEmail(principal),
      role,
      passwordHash: "external:oidc",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.store.createUser(user);
    return user;
  }

  private async ensureExternalUserRole(user: StoredUser, role: UserRole): Promise<StoredUser> {
    if (user.role === role) {
      return user;
    }
    const updated = {
      ...user,
      role,
      updatedAt: nowIso()
    };
    await this.store.updateUser(updated);
    return updated;
  }

  private roleForExternalPrincipal(principal: ExternalPrincipal): UserRole {
    const email = normalizeEmail(principal.email);
    if (email && this.oidcAdminEmails.has(email)) {
      return "admin";
    }
    const subject = requireExternalPrincipalField(principal.subject, "subject");
    if (this.oidcAdminSubjects.has(subject)) {
      return "admin";
    }
    return "member";
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

function publicUser(user: StoredUser): User {
  const { passwordHash: _passwordHash, ...publicFields } = user;
  return structuredClone(publicFields);
}

function externalUserId(principal: ExternalPrincipal): string {
  const issuer = requireExternalPrincipalField(principal.issuer, "issuer");
  const subject = requireExternalPrincipalField(principal.subject, "subject");
  const digest = createHash("sha256").update(`${issuer}\0${subject}`).digest("hex").slice(0, 32);
  return `user_oidc_${digest}`;
}

function externalEmail(principal: ExternalPrincipal): string {
  const email = normalizeEmail(principal.email);
  if (email) {
    return email;
  }
  const subject = requireExternalPrincipalField(principal.subject, "subject");
  const digest = createHash("sha256").update(subject).digest("hex").slice(0, 16);
  return `oidc-${digest}@agentsmith-lite.local`;
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
