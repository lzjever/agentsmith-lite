import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalInMemoryProductStore } from "../../dist/packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApiServer } from "../../dist/packages/api-entry-node/src/server.js";
import { applySandboxReconcileActions, reconcileSandboxRuns } from "../../dist/packages/sandbox-controller/src/reconciler.js";

class FakeSandboxLifecyclePort {
  deletedRefs = [];

  constructor(resources) {
    this.resources = resources.map((resource) => structuredClone(resource));
  }

  async listManagedResources() {
    return this.resources.map((resource) => structuredClone(resource));
  }

  async applyResource() {
    return "applied";
  }

  async waitForPodReady() {
    return "ready";
  }

  async deleteResource(ref) {
    this.deletedRefs.push(structuredClone(ref));
    return "deleted";
  }
}

class UnsafeSandboxRunStore {
  constructor(runs) {
    this.runs = new Map(runs.map((run) => [run.runId, structuredClone(run)]));
  }

  async put(run) {
    this.runs.set(run.runId, structuredClone(run));
    return structuredClone(run);
  }

  async get(runId) {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : null;
  }

  async list() {
    return [...this.runs.values()].map((run) => structuredClone(run));
  }

  async listActive() {
    return (await this.list()).filter((run) => run.cleanupStatus !== "cleaned" && run.phase !== "cleaned");
  }

  async updateWithFencing(runId, expectedFencingToken, run) {
    const current = this.runs.get(runId);
    if (!current || current.fencingToken !== expectedFencingToken) {
      return null;
    }
    this.runs.set(runId, structuredClone(run));
    return structuredClone(run);
  }
}

let server;
let dataRoot;

try {
  dataRoot = await mkdtempRoot();
  const store = createLocalInMemoryProductStore();
  const run = sandboxRun({
    phase: "stopping",
    cleanupStatus: "cleanup_requested",
    directories: runtimeDirectories(dataRoot, "task1"),
    lastCleanupError: {
      at: "2026-07-04T00:00:00.000Z",
      target: "runtime_directory:home",
      message: "previous cleanup failed with bsk_operator_e2e_secret sk-operator-e2e-secret MODEL_API_KEY"
    }
  });
  store.sandboxRuns = new UnsafeSandboxRunStore([run]);
  await seedRuntimeDirs(run);
  await store.createTask(taskForRun(run, "running"));
  const port = new FakeSandboxLifecyclePort(createdResourcesForRun({ ...run, phase: "running", cleanupStatus: "active" }));

  server = await createApiServer({
    port: 0,
    dataRoot,
    builtinAdminPassword: "admin-password",
    sessionSecret: "operator-e2e-session-secret",
    store,
    sandboxLifecyclePort: port
  });

  const auth = await login(server.baseUrl);
  const status = await requestJson(server.baseUrl, "GET", "/api/operator/sandbox/status", undefined, auth);
  assert.equal(status.activeTaskCount, 1, "active task count mismatch");
  assert.equal(status.runCounts.cleanupRequested, 1, "cleanup requested run count mismatch");
  assert.equal(status.observedResourceCounts.Pod, 1, "observed Pod count mismatch");
  assert.ok(hasTarget(status, { type: "delete_resource", kind: "Pod", runId: run.runId }), "Pod delete target missing");
  assert.deepEqual(runtimeTargetPairs(status), [
    ["home", "delete"],
    ["botified", "delete"],
    ["artifacts", "retain"]
  ]);
  assert.deepEqual(status.recentCleanupFailures.map((failure) => [failure.runId, failure.target]), [
    [run.runId, "runtime_directory:home"]
  ]);
  assertRedactedCleanupFailure(status);
  assertNoSecrets(status);

  const beforeRun = await store.sandboxRuns.get(run.runId);
  const dryRun = await requestJson(server.baseUrl, "POST", "/api/operator/sandbox/reap", {}, auth);
  assert.equal(dryRun.dryRun, true, "reap should default to dry-run");
  assert.ok(hasTarget(dryRun, { type: "store_run_state", runId: run.runId }), "store_run_state target missing");
  assert.deepEqual(port.deletedRefs, [], "dry-run must not delete Kubernetes resources");
  assert.deepEqual(await store.sandboxRuns.get(run.runId), beforeRun, "dry-run must not mutate run state");
  assertRedactedCleanupFailure(dryRun);
  assertNoSecrets(dryRun);

  console.log(JSON.stringify({
    status: "ok",
    baseUrl: server.baseUrl,
    activeTaskCount: status.activeTaskCount,
    cleanupTargetCount: dryRun.cleanupPlan.targets.length
  }, null, 2));
} finally {
  await server?.close();
  if (dataRoot) {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function mkdtempRoot() {
  return mkdtemp(path.join(tmpdir(), "asl-operator-lifecycle-"));
}

async function login(baseUrl) {
  await requestJson(baseUrl, "POST", "/api/auth/bootstrap", { password: "admin-password" });
  const response = await raw(baseUrl, "POST", "/api/auth/login", {
    email: "admin@agentsmith-lite.local",
    password: "admin-password"
  });
  return {
    cookie: response.headers.get("set-cookie").split(";")[0],
    csrfToken: (await response.json()).csrfToken
  };
}

async function requestJson(baseUrl, method, pathname, body, auth) {
  const response = await raw(baseUrl, method, pathname, body, auth);
  return response.json();
}

async function raw(baseUrl, method, pathname, body, auth) {
  const headers = { "content-type": "application/json" };
  if (auth?.cookie) headers.cookie = auth.cookie;
  if (auth?.csrfToken && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers["x-csrf-token"] = auth.csrfToken;
  }
  const response = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

async function seedRuntimeDirs(run) {
  await mkdir(run.directories.taskHome, { recursive: true });
  await mkdir(run.directories.botified, { recursive: true });
  await mkdir(run.directories.artifacts, { recursive: true });
  await writeFile(path.join(run.directories.artifacts, "keep.txt"), "durable artifact\n");
}

function hasTarget(result, expected) {
  return result.cleanupPlan.targets.some((target) =>
    Object.entries(expected).every(([key, value]) => target[key] === value)
  );
}

function runtimeTargetPairs(result) {
  return result.cleanupPlan.targets
    .filter((target) => target.type === "runtime_directory")
    .map((target) => [target.directory, target.action]);
}

function assertNoSecrets(value) {
  assert.doesNotMatch(JSON.stringify(value), /bsk_operator_e2e_secret|sk-operator-e2e-secret|MODEL_API_KEY|operator-e2e-session-secret/);
}

function assertRedactedCleanupFailure(result) {
  const message = result.recentCleanupFailures[0]?.message ?? "";
  assert.match(message, /previous cleanup failed/);
  assert.match(message, /<redacted>/);
}

function sandboxRun(overrides = {}) {
  return {
    workspaceId: "ws1",
    projectId: "proj1",
    taskId: "task1",
    runId: "run1",
    namespace: "agentsmith",
    phase: "running",
    image: "agentsmith-lite/botified-runner:test",
    pvcName: "agentsmith-lite-files",
    projectSubPath: "workspaces/ws1/projects/proj1",
    botifiedPort: 3099,
    resourceNames: {
      pod: "asl-task-task1",
      service: "asl-task-task1",
      configMap: "asl-task-task1-config",
      secret: "asl-botified-task1",
      serviceAccount: "asl-task-task1",
      networkPolicy: "asl-task-task1"
    },
    serviceKeySecretRef: {
      name: "asl-botified-task1",
      key: "BOTIFIED_SERVICE_KEY"
    },
    directories: {
      taskHome: "/workspace/project/tasks/task1/home",
      artifacts: "/workspace/project/tasks/task1/artifacts",
      botified: "/workspace/project/tasks/task1/botified"
    },
    resourceLimits: {
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi"
    },
    expiresAt: "2026-07-04T01:00:00.000Z",
    idleExpiresAt: "2026-07-04T00:30:00.000Z",
    fencingToken: 1,
    cleanupStatus: "active",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    ...overrides
  };
}

function runtimeDirectories(root, taskId) {
  const taskRoot = path.join(root, "workspaces/ws1/projects/proj1/tasks", taskId);
  return {
    taskHome: path.join(taskRoot, "home"),
    artifacts: path.join(taskRoot, "artifacts"),
    botified: path.join(taskRoot, "botified")
  };
}

function taskForRun(run, status) {
  return {
    id: run.taskId,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    endpointId: `endpoint-${run.taskId}`,
    prompt: "build",
    status,
    runId: run.runId,
    sandbox: {
      dryRun: true,
      namespace: run.namespace,
      resources: []
    },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

function createdResourcesForRun(run) {
  return applySandboxReconcileActions({
    observedResources: [],
    actions: reconcileSandboxRuns({
      namespace: run.namespace,
      desiredRuns: [run],
      observedResources: [],
      now: new Date("2026-07-04T00:00:00.000Z")
    }).actions
  }).observedResources;
}
