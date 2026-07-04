import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AuthSession, StoredUser, User } from "../../contracts/src/api.js";
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

export class AuthService {
  constructor(
    private readonly store: ProductStore,
    private readonly builtinAdminPassword: string,
    private readonly sessionSecret: string
  ) {}

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

  async requireSession(sessionId: string | null): Promise<User> {
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
    return publicUser(user);
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

