export type TaskWorkspaceView = "conversation" | "terminal" | "artifacts";

export type TaskPathScope = {
  appBasePath: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
};
export type TaskProjectPathScope = Omit<TaskPathScope, "taskId">;

export function taskViewFromSearch(search: string): TaskWorkspaceView {
  const view = new URLSearchParams(search).get("view");
  return view === "terminal" || view === "artifacts" ? view : "conversation";
}

export function canonicalTaskHref(
  scope: TaskPathScope,
  view: TaskWorkspaceView,
  hash = ""
): string {
  const path = `${scope.appBasePath}${taskRoute(scope)}`;
  const query = view === "conversation" ? "" : `?view=${view}`;
  return `${path}${query}${hash}`;
}

export function validateTaskReturnTo(
  value: string | null,
  scope: TaskProjectPathScope
): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex < 0 ? value : value.slice(0, hashIndex);
  const hash = hashIndex < 0 ? "" : value.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const pathname = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : beforeHash.slice(queryIndex + 1);
  if (!validEncoding(pathname) || !validEncoding(query.replaceAll("+", " ")) || !validEncoding(hash)) return null;
  const view = canonicalReturnView(query, queryIndex >= 0);
  if (view === null) return null;

  if (!pathname.startsWith(scope.appBasePath)) return null;
  const route = pathname.slice(scope.appBasePath.length);
  const segments = route.split("/");
  if (
    segments.length !== 7
    || segments[0] !== ""
    || segments[1] !== "workspaces"
    || segments[3] !== "projects"
    || segments[5] !== "tasks"
  ) return null;
  const decoded = segments.map((segment) => decodeURIComponent(segment));
  if (
    decoded.some((segment) => segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))
    || decoded[2] !== scope.workspaceId
    || decoded[4] !== scope.projectId
    || !decoded[6]
  ) return null;

  const canonicalScope: TaskPathScope = {
    ...scope,
    appBasePath: "",
    taskId: decoded[6],
  };
  const canonicalHash = canonicalTaskHash(hash);
  return canonicalTaskHref(canonicalScope, view, canonicalHash);
}

export function filesReturnToAfterNavigation(
  current: string | null,
  candidate: string | null,
  scope: TaskProjectPathScope,
  navigation: "location" | "library"
): string | null {
  return navigation === "library" ? current : validateTaskReturnTo(candidate, scope);
}

function taskRoute(scope: TaskPathScope): string {
  return `/workspaces/${encodeURIComponent(scope.workspaceId)}`
    + `/projects/${encodeURIComponent(scope.projectId)}`
    + `/tasks/${encodeURIComponent(scope.taskId)}`;
}

function validEncoding(value: string): boolean {
  try {
    decodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function canonicalTaskHash(hash: string): string {
  if (!hash) return "";
  const decoded = decodeURIComponent(hash.slice(1));
  return decoded ? `#${encodeURIComponent(decoded)}` : "";
}

function canonicalReturnView(
  query: string,
  hasQuery: boolean
): TaskWorkspaceView | null {
  if (!hasQuery) return "conversation";
  if (!query || query.includes("&")) return null;
  const separator = query.indexOf("=");
  if (separator < 1 || separator !== query.lastIndexOf("=")) return null;
  const key = decodeURIComponent(query.slice(0, separator));
  const value = decodeURIComponent(query.slice(separator + 1));
  return key === "view" && (value === "terminal" || value === "artifacts")
    ? value
    : null;
}
