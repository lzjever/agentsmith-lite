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
    const run = sandboxRun({ phase: "stopping", cleanupStatus: "cleanup_requested" });
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
    assert.equal(status.runCounts.cleanupRequested, 1);
    assert.equal(status.observedResourceCounts.Pod, 0);
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
    assert.equal((await store.sandboxRuns.get(run.runId))?.cleanupStatus, "cleanup_requested");
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
