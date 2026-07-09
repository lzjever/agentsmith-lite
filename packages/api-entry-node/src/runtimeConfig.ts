import { DEFAULT_SANDBOX_NAMESPACE_LIMIT } from "../../domain/src/sandboxDefaults.js";

export type AuthMode = "builtin_admin" | "oidc";
export type SandboxMode = "dry-run" | "live";

export interface RuntimeAuthConfig {
  mode: AuthMode;
  oidc?: OidcRuntimeConfig;
}

export interface OidcRuntimeConfig {
  issuerUrl: string;
  backchannelBaseUrl?: string;
  clientId: string;
  clientSecret: string;
  adminEmails?: string[];
  adminSubjects?: string[];
}

const oidcRuntimeKeys = [
  "OIDC_ISSUER_URL",
  "OIDC_BACKCHANNEL_BASE_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_ADMIN_EMAILS",
  "OIDC_ADMIN_SUBJECTS"
] as const;

export function parseAuthMode(value: string | undefined): AuthMode {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "builtin_admin";
  }
  if (trimmed === "builtin_admin") {
    return "builtin_admin";
  }
  if (trimmed === "oidc") {
    return "oidc";
  }
  throw new Error("AUTH_MODE must be empty, builtin_admin, or oidc");
}

export function parseRuntimeAuthConfig(env: Record<string, string | undefined>): RuntimeAuthConfig {
  const mode = parseAuthMode(env.AUTH_MODE);
  if (mode === "oidc") {
    return { mode, oidc: requireOidcRuntimeConfig(env) };
  }
  rejectOidcRuntimeConfigForBuiltinAuth(env);
  return { mode };
}

export function requireOidcRuntimeConfig(env: Record<string, string | undefined>): OidcRuntimeConfig {
  const issuerUrl = requireHttpUrl(env.OIDC_ISSUER_URL, "OIDC_ISSUER_URL");
  const backchannelBaseUrl = optionalHttpUrl(env.OIDC_BACKCHANNEL_BASE_URL, "OIDC_BACKCHANNEL_BASE_URL");
  const clientId = requireNonEmpty(env.OIDC_CLIENT_ID, "OIDC_CLIENT_ID");
  const clientSecret = requireNonEmpty(env.OIDC_CLIENT_SECRET, "OIDC_CLIENT_SECRET");
  const adminEmails = parseList(env.OIDC_ADMIN_EMAILS).map((email) => email.toLowerCase());
  const adminSubjects = parseList(env.OIDC_ADMIN_SUBJECTS);
  return {
    issuerUrl,
    ...(backchannelBaseUrl ? { backchannelBaseUrl } : {}),
    clientId,
    clientSecret,
    ...(adminEmails.length > 0 ? { adminEmails } : {}),
    ...(adminSubjects.length > 0 ? { adminSubjects } : {})
  };
}

export function parseSandboxMode(value: string | undefined): SandboxMode {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "dry-run";
  }
  if (trimmed === "dry-run" || trimmed === "live") {
    return trimmed;
  }
  throw new Error("AGENTSMITH_LITE_SANDBOX_MODE must be either dry-run or live");
}

export function optionalRuntimeTickIntervalMs(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error("AGENTSMITH_LITE_RUNTIME_TICK_MS must be a positive integer");
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("AGENTSMITH_LITE_RUNTIME_TICK_MS must be a positive integer");
  }
  return parsed;
}

export function parseSandboxNamespaceLimit(value: string | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    return DEFAULT_SANDBOX_NAMESPACE_LIMIT;
  }
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error("AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT must be a positive integer");
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("AGENTSMITH_LITE_SANDBOX_NAMESPACE_LIMIT must be a positive integer");
  }
  return parsed;
}

function requireNonEmpty(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required when AUTH_MODE=oidc`);
  }
  return trimmed;
}

function requireHttpUrl(value: string | undefined, name: string): string {
  const trimmed = requireNonEmpty(value, name);
  return parseHttpUrl(trimmed, name);
}

function optionalHttpUrl(value: string | undefined, name: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return parseHttpUrl(trimmed, name);
}

function parseHttpUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an http or https URL when AUTH_MODE=oidc`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be an http or https URL when AUTH_MODE=oidc`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function rejectOidcRuntimeConfigForBuiltinAuth(env: Record<string, string | undefined>): void {
  for (const key of oidcRuntimeKeys) {
    if (env[key]?.trim()) {
      throw new Error(`${key} must be empty when AUTH_MODE=builtin_admin`);
    }
  }
}
