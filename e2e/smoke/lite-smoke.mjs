import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiServer } from "../../dist/packages/api-entry-node/src/server.js";

const args = parseArgs(process.argv.slice(2));
let server;
let dataRoot;
let baseUrl = args.baseUrl;
if (!baseUrl) {
  dataRoot = await mkdtemp(path.join(tmpdir(), "asl-e2e-"));
  server = await createApiServer({
    port: 0,
    dataRoot,
    builtinAdminPassword: "admin-password",
    sessionSecret: "e2e-session-secret"
  });
  baseUrl = server.baseUrl;
}

try {
  const health = await request("GET", "/api/health");
  assert(health.status === "ok", "health failed");
  await request("POST", "/api/auth/bootstrap", { password: "admin-password" });
  const login = await raw("POST", "/api/auth/login", {
    email: "admin@agentsmith-lite.local",
    password: "admin-password"
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const csrfToken = (await login.json()).csrfToken;
  const workspace = await request("POST", "/api/workspaces", { name: "E2E Workspace" }, cookie, csrfToken);
  const project = await request("POST", `/api/workspaces/${workspace.id}/projects`, { name: "E2E Project" }, cookie, csrfToken);
  const endpoint = await request("POST", `/api/projects/${project.id}/endpoints`, {
    name: "E2E Endpoint",
    protocol: "openai_chat_completions",
    baseUrl: "https://models.example.com/v1",
    model: "gpt-compatible",
    apiKeySecretRef: "secret/e2e",
    capabilities: ["text"],
    requestTimeoutSecs: 30
  }, cookie, csrfToken);
  const task = await request("POST", `/api/projects/${project.id}/tasks`, {
    endpointId: endpoint.id,
    prompt: "E2E task"
  }, cookie, csrfToken);
  assert(task.sandbox.resources.some((resource) => resource.kind === "NetworkPolicy"), "sandbox network policy missing");
  console.log(JSON.stringify({ status: "ok", baseUrl, taskId: task.id }, null, 2));
} finally {
  await server?.close();
  if (dataRoot) {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function request(method, pathname, body, cookie, csrf) {
  const response = await raw(method, pathname, body, cookie, csrf);
  return response.json();
}

async function raw(method, pathname, body, cookie, csrf) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  const response = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base-url") {
      parsed.baseUrl = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

