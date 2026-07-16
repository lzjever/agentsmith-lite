export function workspaceReturnPath(
  value: string | null,
  currentPath: string,
  pagePath: string,
): string {
  if (!value || value.includes("\\")) return "/";
  const appBasePath = currentPath.endsWith(pagePath)
    ? currentPath.slice(0, -pagePath.length)
    : "";
  const route = appBasePath && value.startsWith(`${appBasePath}/`)
    ? value.slice(appBasePath.length)
    : value;
  return route.startsWith("/workspaces/") ? route : "/";
}
