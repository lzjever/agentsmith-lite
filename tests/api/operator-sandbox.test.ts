import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApiServer, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";
import type { SandboxRunState } from "../../packages/sandbox-controller/src/reconciler.js";

describe("operator sandbox API", () => {
  let api: RunningApiServer | undefined;
  let dataRoot = "";

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-operator-api-"));
  });

  afterEach(async () => {
    await api?.close();
    api = undefined;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("requires auth and CSRF while defaulting reap to dry-run", async () => {
    const store = createLocalInMemoryProductStore();
    const run = sandboxRun({
      phase: "stopping",
      cleanupStatus: "cleanup_requested",
      directories: runtimeDirectories(dataRoot, "task1"),
      lastCleanupError: {
        at: "2026-07-04T00:00:00.000Z",
        target: "runtime_directory:home",
        message: "previous cleanup failed"
      }
    });
    await store.createTask(taskForRun(run, "running"));
    await store.sandboxRuns.put(run);
    api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password",
      store
    });

    const unauthenticated = await fetch(api.baseUrl + "/api/operator/sandbox/status");
    assert.equal(unauthenticated.status, 401);

    const auth = await login(api.baseUrl);
    const status = await auth.requestJson("GET", "/api/operator/sandbox/status");
    assert.equal(status.activeTaskCount, 1);
    assert.equal(status.runCounts.cleanupRequested, 1);
    assert.equal(status.observedResourceCounts.Pod, 0);
    assert.ok(status.cleanupPlan.targets.some((target: { type: string; runId?: string; reason?: string }) =>
      target.type === "store_run_state" &&
      target.runId === run.runId &&
      target.reason === "cleanup_complete"
    ));
    assert.deepEqual(
      status.cleanupPlan.targets
        .filter((target: { type: string }) => target.type === "runtime_directory")
        .map((target: { directory: string; action: string }) => [target.directory, target.action]),
      [
        ["home", "delete"],
        ["botified", "delete"],
        ["artifacts", "retain"]
      ]
    );
    assert.deepEqual(status.recentCleanupFailures.map((failure: { runId: string; target: string }) => [failure.runId, failure.target]), [
      [run.runId, "runtime_directory:home"]
    ]);
    assert.doesNotMatch(JSON.stringify(status), /bsk_|sk-real/);

    const missingCsrf = await fetch(api.baseUrl + "/api/operator/sandbox/reap", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie
      },
      body: JSON.stringify({})
    });
    assert.equal(missingCsrf.status, 403);

    const dryRun = await auth.requestJson("POST", "/api/operator/sandbox/reap", {});
    assert.equal(dryRun.dryRun, true);
    assert.ok(dryRun.actionSummary.some((action: { type: string }) => action.type === "store_run_state"));
    assert.deepEqual(
      dryRun.cleanupPlan.targets.map((target: { type: string; directory?: string; action?: string; runId?: string }) =>
        target.type === "runtime_directory" ? `${target.type}:${target.directory}:${target.action}` : `${target.type}:${target.runId ?? ""}`
      ),
      status.cleanupPlan.targets.map((target: { type: string; directory?: string; action?: string; runId?: string }) =>
        target.type === "runtime_directory" ? `${target.type}:${target.directory}:${target.action}` : `${target.type}:${target.runId ?? ""}`
      )
    );
    assert.doesNotMatch(JSON.stringify(dryRun), /bsk_|sk-|MODEL_API_KEY/);
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");
  });

  it("reports cleanup action summaries for expired sandbox runs", async () => {
    const store = createLocalInMemoryProductStore();
    await store.sandboxRuns.put(sandboxRun({
      directories: runtimeDirectories(dataRoot, "task1"),
      expiresAt: "2000-01-01T00:00:00.000Z",
      idleExpiresAt: "2999-01-01T00:00:00.000Z"
    }));
    api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password",
      store
    });
    const auth = await login(api.baseUrl);

    const status = await auth.requestJson("GET", "/api/operator/sandbox/status");

    assert.equal(status.runCounts.active, 1);
    assert.equal(status.activeTaskCount, 0);
    assert.ok(status.actionSummary.some((action: { type: string; runId?: string; reason?: string }) =>
      action.type === "store_run_state" &&
      action.runId === "run1" &&
      action.reason === "cleanup_complete"
    ));
    assert.ok(status.cleanupPlan.targets.some((target: { type: string; directory?: string; action?: string }) =>
      target.type === "runtime_directory" &&
      target.directory === "artifacts" &&
      target.action === "retain"
    ));
    assert.doesNotMatch(JSON.stringify(status), /bsk_|sk-real/);
  });

  it("passes runId query scope to sandbox status while preserving admin auth", async () => {
    const store = createLocalInMemoryProductStore();
    const otherRun = sandboxRun({
      expiresAt: "2999-01-01T00:00:00.000Z",
      idleExpiresAt: "2999-01-01T00:00:00.000Z",
      directories: runtimeDirectories(dataRoot, "task1")
    });
    const scopedRun = sandboxRunFor("task2", "run2", {
      phase: "stopping",
      cleanupStatus: "cleanup_requested",
      directories: runtimeDirectories(dataRoot, "task2"),
      lastCleanupError: {
        at: "2026-07-04T00:00:00.000Z",
        target: "runtime_directory:home",
        message: "previous scoped cleanup failed"
      }
    });
    await store.createTask(taskForRun(otherRun, "running"));
    await store.createTask(taskForRun(scopedRun, "running"));
    await store.sandboxRuns.put(otherRun);
    await store.sandboxRuns.put(scopedRun);
    api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password",
      store
    });

    const unauthenticated = await fetch(api.baseUrl + "/api/operator/sandbox/status?runId=run2");
    assert.equal(unauthenticated.status, 401);

    const auth = await login(api.baseUrl);
    const globalStatus = await auth.requestJson("GET", "/api/operator/sandbox/status");
    assert.equal(globalStatus.activeTaskCount, 2);
    assert.equal(globalStatus.runCounts.total, 2);

    const scopedStatus = await auth.requestJson("GET", "/api/operator/sandbox/status?runId=run2");
    assert.equal(scopedStatus.activeTaskCount, 1);
    assert.equal(scopedStatus.runCounts.total, 1);
    assert.equal(scopedStatus.runCounts.cleanupRequested, 1);
    assert.deepEqual(
      scopedStatus.cleanupPlan.targets.map((target: { runId?: string }) => target.runId),
      ["run2", "run2", "run2", "run2"]
    );
    assert.deepEqual(scopedStatus.recentCleanupFailures.map((failure: { runId: string; target: string }) => [failure.runId, failure.target]), [
      ["run2", "runtime_directory:home"]
    ]);
    assert.doesNotMatch(JSON.stringify(scopedStatus), /bsk_|sk-real|MODEL_API_KEY/);
  });
});

async function login(baseUrl: string) {
  await fetch(baseUrl + "/api/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "admin-password" })
  });
  const loginResponse = await fetch(baseUrl + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "admin@agentsmith-lite.local",
      password: "admin-password"
    })
  });
  const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
  const csrf = (await loginResponse.json() as { csrfToken: string }).csrfToken;
  return {
    cookie,
    requestJson: async (method: string, pathname: string, body?: unknown) => {
      const headers: Record<string, string> = { "content-type": "application/json", cookie };
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        headers["x-csrf-token"] = csrf;
      }
      const response = await fetch(baseUrl + pathname, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      if (response.status !== 200) {
        assert.fail(await response.text());
      }
      return response.json();
    }
  };
}

function sandboxRun(overrides: Partial<SandboxRunState> = {}): SandboxRunState {
  return {
    workspaceId: "ws1",
    projectId: "proj1",
    taskId: "task1",
    runId: "run1",
    namespace: "agentsmith",
    phase: "starting",
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

function sandboxRunFor(taskId: string, runId: string, overrides: Partial<SandboxRunState> = {}): SandboxRunState {
  return sandboxRun({
    taskId,
    runId,
    resourceNames: {
      pod: `asl-task-${taskId}`,
      service: `asl-task-${taskId}`,
      configMap: `asl-task-${taskId}-config`,
      secret: `asl-botified-${taskId}`,
      serviceAccount: `asl-task-${taskId}`,
      networkPolicy: `asl-task-${taskId}`
    },
    serviceKeySecretRef: {
      name: `asl-botified-${taskId}`,
      key: "BOTIFIED_SERVICE_KEY"
    },
    ...overrides
  });
}

function runtimeDirectories(dataRoot: string, taskId: string) {
  const taskRoot = path.join(dataRoot, "workspaces/ws1/projects/proj1/tasks", taskId);
  return {
    taskHome: path.join(taskRoot, "home"),
    artifacts: path.join(taskRoot, "artifacts"),
    botified: path.join(taskRoot, "botified")
  };
}

function taskForRun(run: SandboxRunState, status: "running" | "completed") {
  return {
    id: run.taskId,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    endpointId: `endpoint-${run.taskId}`,
    prompt: "build",
    status,
    runId: run.runId,
    sandbox: {
      dryRun: true as const,
      namespace: run.namespace,
      resources: []
    },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}
