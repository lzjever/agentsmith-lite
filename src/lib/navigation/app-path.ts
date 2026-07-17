const API_PATH_SUFFIX = "/api/v1";

export function appPath(route: string): string {
  return appPathForApiBase(route, process.env.NEXT_PUBLIC_API_BASE_PATH || API_PATH_SUFFIX);
}

export function appPathForApiBase(route: string, apiBasePath: string): string {
  const basePath = apiBasePath.endsWith(API_PATH_SUFFIX)
    ? apiBasePath.slice(0, -API_PATH_SUFFIX.length)
    : "";
  return `${basePath}${route}`;
}
