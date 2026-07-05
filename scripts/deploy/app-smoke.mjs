#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ADMIN_EMAIL = "admin@agentsmith-lite.local";
const WORKSPACE_NAME = "Deploy Smoke";
const PROJECT_NAME = "API Smoke";
const FILE_PATH = "files/deploy-smoke.txt";
const FILE_CONTENT = "hello from deploy smoke\n";
const TASK_ARTIFACT_NAME = "agentsmith-lite-task-smoke.txt";
const TASK_MARKER = "AGENTSMITH_LITE_TASK_SMOKE_MARKER";
const TASK_POLL_INTERVAL_MS = 500;
const DEFAULT_TASK_TIMEOUT_SECS = 45;
const TASK_PROMPT = [
  "Deploy smoke runtime acceptance test.",
  "Use bash in the current task home/cwd to create agentsmith-lite-task-smoke.txt.",
  "The file content must include this exact marker on its own line: AGENTSMITH_LITE_TASK_SMOKE_MARKER.",
  "Then use the Botified publish_file tool to publish that file with filename agentsmith-lite-task-smoke.txt.",
  "Keep the response brief and do not include credentials or endpoint secret references."
].join("\n");
const TASK_RECLAIM_PROMPT = [
  "Deploy smoke task reclaim acceptance test.",
  "Use bash in the current task home/cwd to run a long sleep, for example: sleep 600.",
  "Do not publish files, do not create artifacts, and do not include credentials or endpoint secret references.",
  "The smoke harness will cancel this task and then run scoped sandbox reap checks."
].join("\n");
const TERMINAL_EVENT_KINDS = new Set(["turn_completed", "turn_failed", "runtime_error"]);

const sensitiveValues = new Set();

class UsageError extends Error {}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireOption(args.baseUrl, "--base-url");
  const taskSmoke = taskSmokeEnabled(args);
  const taskReclaimSmoke = taskReclaimSmokeEnabled(args);
  const taskReclaimReapApply = taskReclaimReapApplyEnabled(args);

  if (taskReclaimReapApply && !taskReclaimSmoke) {
    throw new UsageError("task reclaim reap apply requires task reclaim smoke");
  }

  const endpointConfig = endpointSmokeConfig(args);
  if (taskSmoke && !endpointConfig.complete) {
    throw new UsageError(
      "task smoke requires endpoint smoke config: --endpoint-base-url, --endpoint-model, and --endpoint-secret-ref"
    );
  }
  if (taskReclaimSmoke && !endpointConfig.complete) {
    throw new UsageError(
      "task reclaim smoke requires endpoint smoke config: --endpoint-base-url, --endpoint-model, and --endpoint-secret-ref"
    );
  }
  const taskTimeoutSecs = taskSmoke ? taskSmokeTimeoutSecs() : DEFAULT_TASK_TIMEOUT_SECS;

  const adminPassword = process.env.BUILTIN_ADMIN_INITIAL_PASSWORD;
  requireOption(adminPassword, "BUILTIN_ADMIN_INITIAL_PASSWORD");
  sensitiveValues.add(adminPassword);

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
  let endpointId;
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
    endpointId = requireString(endpoint.id, "endpoint id");
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

  let task = { status: "skipped" };
  if (taskSmoke) {
    task = await runTaskSmoke(smoke, projectId, requireString(endpointId, "endpoint id"), taskTimeoutSecs);
  }

  const report = {
    status: "ok",
    profile: taskSmoke || taskReclaimSmoke ? "full" : "light",
    baseUrl: args.baseUrl,
    workspaceId,
    projectId,
    chat,
    task
  };

  if (taskReclaimSmoke) {
    report.taskReclaim = await runTaskReclaimSmoke(
      smoke,
      projectId,
      requireString(endpointId, "endpoint id"),
      taskReclaimReapApply
    );
  }

  const reportJson = `${JSON.stringify(report)}\n`;
  if (args.report) {
    await writeReport(args.report, reportJson);
  }
  process.stdout.write(reportJson);
}

async function runTaskSmoke(smoke, projectId, endpointId, timeoutSecs) {
  let taskId;
  let createStatus;
  let completed = false;
  try {
    const create = await smoke.fetchJson("POST", `/api/projects/${encodeURIComponent(projectId)}/tasks`, {
      auth: true,
      body: {
        endpointId,
        prompt: TASK_PROMPT
      }
    });
    taskId = requireString(create.body.id, "task id");
    createStatus = requireString(create.body.status, "task create status");

    const verified = await waitForVerifiedTaskArtifact(smoke, taskId, timeoutSecs);
    completed = true;
    return {
      status: "completed",
      taskId,
      createStatus,
      artifactId: verified.artifactId,
      artifactName: verified.artifactName
    };
  } catch (error) {
    if (taskId && !completed) {
      try {
        await smoke.fetchJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
          auth: true
        });
      } catch {
        // Preserve the original task smoke failure.
      }
    }
    throw error;
  }
}

async function waitForVerifiedTaskArtifact(smoke, taskId, timeoutSecs) {
  const deadline = Date.now() + (timeoutSecs * 1000);
  while (Date.now() <= deadline) {
    const encodedTaskId = encodeURIComponent(taskId);
    const events = requireArray(await smoke.requestJson("GET", `/api/tasks/${encodedTaskId}/events`, {
      auth: true
    }), "task events");
    const artifacts = requireArray(await smoke.requestJson("GET", `/api/tasks/${encodedTaskId}/artifacts`, {
      auth: true
    }), "task artifacts");

    for (const artifact of artifacts) {
      const name = typeof artifact?.name === "string" ? artifact.name : "";
      if (name !== TASK_ARTIFACT_NAME) {
        continue;
      }
      const artifactId = requireString(artifact.id, "task artifact id");
      const content = await smoke.requestText(
        "GET",
        `/api/tasks/${encodedTaskId}/artifacts/${encodeURIComponent(artifactId)}/download`,
        { auth: true }
      );
      if (!content.includes(TASK_MARKER)) {
        throw new Error(`artifact ${artifactId} did not contain task smoke marker`);
      }
      return {
        artifactId,
        artifactName: name
      };
    }

    const terminal = events.find((event) => TERMINAL_EVENT_KINDS.has(event?.kind));
    if (terminal) {
      throw new Error(`task smoke reached terminal event ${terminal.kind} before verified artifact`);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await sleep(Math.min(TASK_POLL_INTERVAL_MS, remainingMs));
    }
  }
  throw new Error(`task smoke timed out after ${timeoutSecs} seconds waiting for verified artifact`);
}

async function runTaskReclaimSmoke(smoke, projectId, endpointId, reapApply) {
  const create = await smoke.fetchJson("POST", `/api/projects/${encodeURIComponent(projectId)}/tasks`, {
    auth: true,
    body: {
      endpointId,
      prompt: TASK_RECLAIM_PROMPT
    }
  });
  const taskId = requireString(create.body.id, "task reclaim task id");
  const runId = requireString(create.body.runId, "task reclaim run id");
  const createStatus = requireString(create.body.status, "task reclaim create status");

  const cancel = await smoke.fetchJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
    auth: true
  });
  const cancelStatus = requireString(cancel.body.status, "task reclaim cancel status");

  const reap = {
    dryRun: await runScopedReap(smoke, runId, false, "task reclaim dry-run reap")
  };
  if (reapApply) {
    reap.apply = await runScopedReap(smoke, runId, true, "task reclaim apply reap");
    reap.finalDryRun = await runScopedReap(smoke, runId, false, "task reclaim final dry-run reap");
  }

  return {
    status: "completed",
    taskId,
    runId,
    createStatus,
    cancelStatus,
    reap
  };
}

async function runScopedReap(smoke, runId, apply, context) {
  const result = await smoke.requestJson("POST", "/api/operator/sandbox/reap", {
    auth: true,
    body: apply ? { runId, apply: true } : { runId }
  });
  return summarizeReapResult(result, apply ? false : true, context);
}

function summarizeReapResult(result, expectedDryRun, context) {
  const dryRun = requireBoolean(result?.dryRun, `${context} dryRun`);
  if (dryRun !== expectedDryRun) {
    throw new Error(`${context} returned dryRun=${dryRun}, expected ${expectedDryRun}`);
  }
  const errors = requireArray(result?.errors, `${context} errors`);
  if (errors.length > 0) {
    throw new Error(`${context} reported ${errors.length} error(s)`);
  }
  return {
    dryRun,
    actionCount: requireArray(result?.actionSummary, `${context} action summary`).length,
    cleanupTargetCount: requireArray(result?.cleanupPlan?.targets, `${context} cleanup targets`).length,
    errorCount: errors.length,
    storedRunIds: requireArray(result?.storedRunIds, `${context} stored run ids`).map((runId) =>
      requireString(runId, `${context} stored run id`)
    )
  };
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

  async requestText(method, pathname, options = {}) {
    const response = await this.fetchRaw(method, pathname, options);
    return response.text;
  }

  async fetchJson(method, pathname, options = {}) {
    const response = await this.fetchRaw(method, pathname, options);
    return {
      body: parseJsonResponse(response.text, `${method} ${pathname}`),
      setCookie: response.setCookie
    };
  }

  async fetchRaw(method, pathname, options = {}) {
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
      text,
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
    } else if (arg === "--task-smoke") {
      parsed.taskSmoke = true;
    } else if (arg === "--task-reclaim-smoke") {
      parsed.taskReclaimSmoke = true;
    } else if (arg === "--task-reclaim-reap-apply") {
      parsed.taskReclaimReapApply = true;
    } else if (arg === "--report") {
      parsed.report = requireValue(argv, index, arg);
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

function taskSmokeEnabled(args) {
  const envTaskSmoke = parseSmokeBooleanEnv("SMOKE_TASK");
  return Boolean(args.taskSmoke || envTaskSmoke);
}

function taskReclaimSmokeEnabled(args) {
  const envTaskReclaimSmoke = parseSmokeBooleanEnv("SMOKE_TASK_RECLAIM");
  return Boolean(args.taskReclaimSmoke || envTaskReclaimSmoke);
}

function taskReclaimReapApplyEnabled(args) {
  const envTaskReclaimReapApply = parseSmokeBooleanEnv("SMOKE_TASK_RECLAIM_REAP_APPLY");
  return Boolean(args.taskReclaimReapApply || envTaskReclaimReapApply);
}

function taskSmokeTimeoutSecs() {
  return parsePositiveIntegerEnv("SMOKE_TASK_TIMEOUT_SECS", DEFAULT_TASK_TIMEOUT_SECS);
}

async function writeReport(reportPath, reportJson) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, reportJson, "utf8");
}

function parseSmokeBooleanEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new UsageError(`${name} must be true, false, empty, or unset`);
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

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} missing from API response`);
  }
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new Error(`${name} missing from API response`);
  }
  return value;
}

function parsePositiveIntegerEnv(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new UsageError(`${name} must be a positive integer`);
  }
  return Number(value);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
