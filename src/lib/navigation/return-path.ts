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

export function isCurrentAppPage(value: string | undefined, pagePath: string): boolean {
  const pathname = value?.split(/[?#]/, 1)[0];
  return pathname === pagePath || pathname?.endsWith(pagePath) === true;
}
