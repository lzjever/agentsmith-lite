const value = process.argv[2] ?? process.env.APP_PUBLIC_BASE_URL;

export function publicBaseUrl(value) {
  if (!value?.trim()) {
    throw new Error("APP_PUBLIC_BASE_URL is required");
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("APP_PUBLIC_BASE_URL must be an http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("APP_PUBLIC_BASE_URL must be an http or https URL");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("APP_PUBLIC_BASE_URL must not include a query or fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "/" : "");
}

export function publicBasePathForUrl(value) {
  return new URL(publicBaseUrl(value)).pathname;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(publicBaseUrl(value));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
