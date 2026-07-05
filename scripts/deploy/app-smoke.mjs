#!/usr/bin/env node

const ADMIN_EMAIL = "admin@agentsmith-lite.local";
const WORKSPACE_NAME = "Deploy Smoke";
const PROJECT_NAME = "API Smoke";
const FILE_PATH = "files/deploy-smoke.txt";
const FILE_CONTENT = "hello from deploy smoke\n";

const sensitiveValues = new Set();

class UsageError extends Error {}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireOption(args.baseUrl, "--base-url");

  const adminPassword = process.env.BUILTIN_ADMIN_INITIAL_PASSWORD;
  requireOption(adminPassword, "BUILTIN_ADMIN_INITIAL_PASSWORD");
  sensitiveValues.add(adminPassword);

  const endpointConfig = endpointSmokeConfig(args);
  if (endpointConfig.secretRef) {
    sensitiveValues.add(endpointConfig.secretRef);
  }

  const smoke = new AppSmokeClient(args.baseUrl);
  const health = await smoke.requestJson("GET", "/api/health");
  if (health.status !== "ok") {
    throw new Error("health check did not report ok");
  }
  await smoke.requestJson("POST", "/api/auth/bootstrap", {
    body: { password: adminPassword }
  });
  await smoke.login(ADMIN_EMAIL, adminPassword);

  const workspace = await smoke.requestJson("POST", "/api/workspaces", {
    auth: true,
    body: { name: WORKSPACE_NAME }
  });
  const workspaceId = requireString(workspace.id, "workspace id");

  const project = await smoke.requestJson("POST", `/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, {
    auth: true,
    body: { name: PROJECT_NAME }
  });
  const projectId = requireString(project.id, "project id");

  let chat = { status: "skipped" };
  if (endpointConfig.complete) {
    const endpoint = await smoke.requestJson("POST", `/api/projects/${encodeURIComponent(projectId)}/endpoints`, {
      auth: true,
      body: {
        name: "Deploy Smoke Endpoint",
        protocol: "openai_chat_completions",
        baseUrl: endpointConfig.baseUrl,
        model: endpointConfig.model,
        apiKeySecretRef: endpointConfig.secretRef,
        capabilities: ["text"],
        requestTimeoutSecs: 30
      }
    });
    const endpointId = requireString(endpoint.id, "endpoint id");
    await smoke.requestJson("POST", `/api/projects/${encodeURIComponent(projectId)}/chat`, {
      auth: true,
      body: {
        endpointId,
        messages: [{ role: "user", content: "deploy smoke" }]
      }
    });
    chat = { status: "completed" };
  }

  await smoke.requestJson("POST", `/api/projects/${encodeURIComponent(projectId)}/files`, {
    auth: true,
    body: {
      path: FILE_PATH,
      content: FILE_CONTENT
    }
  });

  const files = await smoke.requestJson("GET", `/api/projects/${encodeURIComponent(projectId)}/files?path=files`, {
    auth: true
  });
  const entries = Array.isArray(files.entries) ? files.entries : [];
  if (!entries.some((entry) => entry && typeof entry === "object" && entry.path === FILE_PATH)) {
    throw new Error("uploaded smoke file was not listed");
  }

  const downloaded = await smoke.requestJson(
    "GET",
    `/api/projects/${encodeURIComponent(projectId)}/files/download?path=${encodeURIComponent(FILE_PATH)}`,
    { auth: true }
  );
  if (downloaded.path !== FILE_PATH || downloaded.content !== FILE_CONTENT) {
    throw new Error("downloaded smoke file did not match uploaded content");
  }

  await smoke.requestJson("DELETE", `/api/projects/${encodeURIComponent(projectId)}/files`, {
    auth: true,
    body: { path: FILE_PATH }
  });

  await smoke.requestJson("GET", "/api/operator/sandbox/status", {
    auth: true
  });

  console.log(JSON.stringify({
    status: "ok",
    baseUrl: args.baseUrl,
    workspaceId,
    projectId,
    chat
  }));
}

class AppSmokeClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = "";
    this.csrfToken = "";
  }

  async login(email, password) {
    const response = await this.fetchJson("POST", "/api/auth/login", {
      body: { email, password }
    });
    this.cookie = cookieFromSetCookie(response.setCookie);
    this.csrfToken = requireString(response.body.csrfToken, "csrf token");
  }

  async requestJson(method, pathname, options = {}) {
    const response = await this.fetchJson(method, pathname, options);
    return response.body;
  }

  async fetchJson(method, pathname, options = {}) {
    const headers = {
      accept: "application/json"
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.auth) {
      requireOption(this.cookie, "session cookie");
      requireOption(this.csrfToken, "CSRF token");
      headers.cookie = this.cookie;
      headers["x-csrf-token"] = this.csrfToken;
    }

    const response = await fetch(joinUrl(this.baseUrl, pathname), {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${pathname} returned ${response.status}: ${redact(text)}`);
    }
    return {
      body: parseJsonResponse(text, `${method} ${pathname}`),
      setCookie: response.headers.get("set-cookie")
    };
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") {
      parsed.baseUrl = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--endpoint-base-url") {
      parsed.endpointBaseUrl = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--endpoint-model") {
      parsed.endpointModel = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--endpoint-secret-ref") {
      parsed.endpointSecretRef = requireValue(argv, index, arg);
      index += 1;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function endpointSmokeConfig(args) {
  const baseUrl = firstNonEmpty(args.endpointBaseUrl, process.env.SMOKE_ENDPOINT_BASE_URL);
  const model = firstNonEmpty(args.endpointModel, process.env.SMOKE_ENDPOINT_MODEL);
  const secretRef = firstNonEmpty(args.endpointSecretRef, process.env.SMOKE_ENDPOINT_SECRET_REF);
  return {
    baseUrl,
    model,
    secretRef,
    complete: Boolean(baseUrl && model && secretRef)
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function requireOption(value, name) {
  if (!value) {
    throw new UsageError(`${name} is required`);
  }
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} missing from API response`);
  }
  return value;
}

function cookieFromSetCookie(setCookie) {
  if (!setCookie) {
    throw new Error("login response did not set session cookie");
  }
  const cookie = setCookie.split(";")[0]?.trim();
  if (!cookie) {
    throw new Error("login response set an empty session cookie");
  }
  return cookie;
}

function parseJsonResponse(text, context) {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
}

function joinUrl(baseUrl, pathname) {
  return new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function redact(value) {
  let redacted = String(value);
  for (const sensitive of sensitiveValues) {
    if (sensitive) {
      redacted = redacted.split(sensitive).join("<redacted>");
    }
  }
  return redacted;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  const message = error instanceof UsageError
    ? error.message
    : `app smoke failed: ${errorMessage(error)}`;
  console.error(redact(message));
  process.exit(error instanceof UsageError ? 2 : 1);
});
