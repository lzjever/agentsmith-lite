import {
  PROJECT_AUDIT_ACTIONS,
  PROJECT_AUDIT_RESOURCE_KINDS,
} from "../../../packages/contracts/src/api.ts";
import type {
  ProjectAuditAction,
  ProjectAuditResourceKind,
} from "../../../packages/contracts/src/api.js";
import { emptyAuditFilters } from "./auditPageState.ts";
import type { AuditFilters } from "./auditPageState.js";

export interface AuditPageNavigation {
  kind: "push" | "replace";
  href: string;
}

const auditActions = new Set<string>(PROJECT_AUDIT_ACTIONS);
const auditResourceKinds = new Set<string>(PROJECT_AUDIT_RESOURCE_KINDS);

export function parseAuditPageFilters(
  input: string | URLSearchParams,
): AuditFilters {
  const params =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;
  const filters = emptyAuditFilters();
  const actorId = validIdentity(params.get("actorId"), true);
  const subjectUserId = validIdentity(params.get("subjectUserId"), false);
  const action = params.get("action");
  const status = params.get("status");
  const resourceKind = params.get("resourceKind");
  const resourceId = params.get("resourceId");
  const from = params.get("from");
  const to = params.get("to");

  return {
    ...filters,
    actorId,
    subjectUserId,
    action: auditActions.has(action ?? "")
      ? (action as ProjectAuditAction)
      : null,
    status:
      status === "accepted" || status === "rejected" ? status : null,
    resourceKind: auditResourceKinds.has(resourceKind ?? "")
      ? (resourceKind as ProjectAuditResourceKind)
      : null,
    resourceId: validResourceId(resourceId) ? resourceId : null,
    from: validTimestamp(from) ? from : null,
    to: validTimestamp(to) ? to : null,
  };
}

export function auditCommittedNavigation(
  currentHref: string,
  filters: AuditFilters,
): AuditPageNavigation {
  return navigation(currentHref, filters, "push");
}

export function auditCanonicalNavigation(
  currentHref: string,
  filters: AuditFilters,
): AuditPageNavigation {
  return navigation(currentHref, filters, "replace");
}

export function auditTimeInputValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function auditTimeValueFromInput(
  value: string,
  boundary: "from" | "through",
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  if (boundary === "from") {
    date.setSeconds(0, 0);
  } else {
    date.setSeconds(59, 999);
  }
  return date.toISOString();
}

function navigation(
  currentHref: string,
  filters: AuditFilters,
  kind: AuditPageNavigation["kind"],
): AuditPageNavigation {
  const url = new URL(currentHref);
  url.search = "";
  setOptional(url.searchParams, "actorId", filters.actorId);
  setOptional(url.searchParams, "subjectUserId", filters.subjectUserId);
  setOptional(url.searchParams, "action", filters.action);
  setOptional(url.searchParams, "status", filters.status);
  setOptional(url.searchParams, "resourceKind", filters.resourceKind);
  setOptional(url.searchParams, "resourceId", filters.resourceId);
  setOptional(url.searchParams, "from", filters.from);
  setOptional(url.searchParams, "to", filters.to);
  return {
    kind,
    href: `${url.pathname}${url.search}${url.hash}`,
  };
}

function setOptional(
  params: URLSearchParams,
  key: string,
  value: string | null,
) {
  if (value) params.set(key, value);
}

function validIdentity(
  value: string | null,
  allowSystem: boolean,
): string | null {
  if (
    !value ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    (!allowSystem && value === "system")
  ) {
    return null;
  }
  return value;
}

function validResourceId(value: string | null): value is string {
  return Boolean(
    value &&
      value.length <= 1024 &&
      !/[\u0000-\u001f\u007f]/u.test(value),
  );
}

function validTimestamp(value: string | null): value is string {
  return Boolean(
    value &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        value,
      ) &&
      Number.isFinite(Date.parse(value)),
  );
}
