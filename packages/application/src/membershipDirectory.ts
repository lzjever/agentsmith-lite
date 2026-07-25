import { ProductError } from "../../domain/src/errors.js";

export const DEFAULT_MEMBERSHIP_LIMIT = 20;
export const MAX_MEMBERSHIP_LIMIT = 50;

export interface MembershipCursorScope {
  actorId: string;
  kind: "workspace-members" | "project-members" | "project-member-candidates";
  scopeId: string;
  q: string;
  role: string | null;
}

export interface MembershipCursorAfter {
  createdAt: string;
  userId: string;
}

export function membershipDirectoryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MEMBERSHIP_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_MEMBERSHIP_LIMIT) {
    throw new ProductError(`limit must be between 1 and ${MAX_MEMBERSHIP_LIMIT}`, 400);
  }
  return value;
}

export function normalizeMembershipQuery(value: string | undefined): string {
  const q = value?.trim().toLowerCase() ?? "";
  if (q.length > 120) throw new ProductError("q must be 120 characters or less", 400);
  if (/[\u0000-\u001f\u007f]/u.test(q)) throw new ProductError("q must not contain control characters", 400);
  return q;
}

export function encodeMembershipCursor(scope: MembershipCursorScope, after: MembershipCursorAfter): string {
  return Buffer.from(JSON.stringify({ v: 1, ...scope, after }), "utf8").toString("base64url");
}

export function decodeMembershipCursor(cursor: string, scope: MembershipCursorScope): MembershipCursorAfter {
  const invalid = () => new ProductError("Membership directory cursor is invalid", 400);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!isRecord(value) || !hasExactKeys(value, ["v", "actorId", "kind", "scopeId", "q", "role", "after"]) || value.v !== 1 || !isRecord(value.after)) throw invalid();
  const after = value.after;
  if (!hasExactKeys(after, ["createdAt", "userId"]) || typeof after.createdAt !== "string" || typeof after.userId !== "string") throw invalid();
  if (!isCanonicalIso(after.createdAt) || !validCursorId(after.userId)) throw invalid();
  const normalized = { v: 1, ...scope, after: { createdAt: after.createdAt, userId: after.userId } };
  if (JSON.stringify(value) !== JSON.stringify(normalized) || encodeMembershipCursor(scope, normalized.after) !== cursor) throw invalid();
  return normalized.after;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function isCanonicalIso(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validCursorId(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
}
