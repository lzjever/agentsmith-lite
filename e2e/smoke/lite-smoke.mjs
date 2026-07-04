import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiServer } from "../../dist/packages/api-entry-node/src/server.js";

const args = parseArgs(process.argv.slice(2));
let server;
let dataRoot;
let baseUrl = args.baseUrl;
const artifactBytes = new TextEncoder().encode("downloaded through product API");
if (!baseUrl) {
  dataRoot = await mkdtemp(path.join(tmpdir(), "asl-e2e-"));
  server = await createApiServer({
    port: 0,
    dataRoot,
    builtinAdminPassword: "admin-password",
    sessionSecret: "e2e-session-secret",
    botifiedClient: fakeBotifiedClient(artifactBytes),
    botifiedServiceKeyFactory: () => "e2e-service-key"
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
  const artifacts = await request("GET", `/api/tasks/${task.id}/artifacts`, undefined, cookie);
  assert(artifacts.length === 1, "published artifact missing from product API");
  assert(artifacts[0].name === "e2e-report.txt", "published artifact name mismatch");
  const download = await raw("GET", `/api/tasks/${task.id}/artifacts/${artifacts[0].id}/download`, undefined, cookie);
  assert(await download.text() === "downloaded through product API", "artifact download content mismatch");
  console.log(JSON.stringify({ status: "ok", baseUrl, taskId: task.id, artifactId: artifacts[0].id }, null, 2));
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

function fakeBotifiedClient(bytes) {
  const reads = [
    {
      status: "ok",
      events: [
        {
          cursor: "c1",
          seq: 1,
          session_id: "s1",
          type: "file.published",
          payload: {
            file_id: "e2e_file_1",
            filename: "e2e-report.txt",
            mime_type: "text/plain",
            size_bytes: bytes.byteLength,
            sha256: "c".repeat(64),
            download_url: "http://botified.internal/v1/files/e2e_file_1?service_key=e2e-service-key"
          }
        }
      ],
      nextCursor: "c1"
    }
  ];
  return {
    async health() {
      return { status: "ok" };
    },
    async postMessage() {
      return { accepted: true, messageId: "msg_1", cursor: "post-cursor" };
    },
    async readTimeline(_baseUrl, _serviceKey, cursor) {
      const next = reads.shift();
      if (next) return next;
      return cursor ? { status: "ok", events: [], nextCursor: cursor } : { status: "ok", events: [] };
    },
    async uploadFile() {
      return { files: [] };
    },
    async downloadFile(_baseUrl, _serviceKey, fileId) {
      assert(fileId === "e2e_file_1", "unexpected Botified file id");
      return {
        bytes,
        filename: "e2e-report.txt",
        mimeType: "text/plain",
        sizeBytes: bytes.byteLength
      };
    },
    async abort() {
      return { aborted: true };
    }
  };
}
