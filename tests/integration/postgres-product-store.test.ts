import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import pg from "pg";
import type { AgentTask, AgentTaskArtifact, AgentTaskEvent, ModelEndpoint, Project, StoredUser, Workspace } from "../../packages/contracts/src/api.js";
import { PostgresProductStore } from "../../packages/adapters-postgres/src/postgresProductStore.js";
import type { SandboxRunState } from "../../packages/sandbox-controller/src/reconciler.js";

const postgresUrl = process.env.POSTGRES_APP_URL;
const postgresDescribe = postgresUrl ? describe : describe.skip;

postgresDescribe("postgres product store", () => {
  assert.ok(postgresUrl);
  const store = new PostgresProductStore(postgresUrl);

  beforeEach(async () => {
    const client = new pg.Client({ connectionString: postgresUrl });
    await client.connect();
    try {
      await client.query(`
        truncate table
          agent_task_artifacts,
          agent_task_events,
          agent_tasks,
          model_endpoints,
          projects,
          workspaces,
          auth_sessions,
          users,
          postgres_json_docs,
          runtime_leases
        cascade
      `);
    } finally {
      await client.end();
    }
  });

  after(async () => {
    await store.close();
  });

  it("persists product records with idempotent task event and artifact appends", async () => {
    const user: StoredUser = {
      id: "user_pg",
      email: "User@Example.test",
      role: "admin",
      passwordHash: "hash",
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z"
    };
    const workspace: Workspace = {
      id: "ws_pg",
      name: "Ops",
      ownerUserId: user.id,
      createdAt: "2026-07-04T00:01:00.000Z",
      updatedAt: "2026-07-04T00:01:00.000Z"
    };
    const project: Project = {
      id: "proj_pg",
      workspaceId: workspace.id,
      name: "Sandbox",
      ownerUserId: user.id,
      rootPath: "workspaces/ws_pg/projects/proj_pg",
      taskConcurrencyLimit: 2,
      createdAt: "2026-07-04T00:02:00.000Z",
      updatedAt: "2026-07-04T00:02:00.000Z"
    };
    const endpoint: ModelEndpoint = {
      id: "endp_pg",
      projectId: project.id,
      name: "OpenAI compatible",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.test/v1",
      model: "gpt-compatible",
      apiKeySecretRef: "secret/openai",
      capabilities: ["text", "tool_calls"],
      requestTimeoutSecs: 30,
      createdAt: "2026-07-04T00:03:00.000Z",
      updatedAt: "2026-07-04T00:03:00.000Z"
    };
    const task: AgentTask = {
      id: "task_pg",
      workspaceId: workspace.id,
      projectId: project.id,
      endpointId: endpoint.id,
      prompt: "build",
      status: "starting",
      runId: "run_pg",
      sandbox: { dryRun: true, namespace: "agentsmith", resources: [] },
      createdAt: "2026-07-04T00:04:00.000Z",
      updatedAt: "2026-07-04T00:04:00.000Z"
    };
    const event: AgentTaskEvent = {
      id: "evt_pg",
      taskId: task.id,
      kind: "assistant_message",
      cursor: "timeline:old:1",
      botifiedSeq: 1,
      botifiedType: "message",
      sessionId: "sess_pg",
      payload: { text: "hello" },
      createdAt: "2026-07-04T00:05:00.000Z"
    };
    const resetEvent: AgentTaskEvent = {
      ...event,
      id: "evt_pg_reset",
      kind: "turn_completed",
      cursor: "timeline:new:1",
      botifiedType: "cycle.completed",
      payload: { ok: true },
      createdAt: "2026-07-04T00:05:01.000Z"
    };
    const duplicateResetEvent: AgentTaskEvent = {
      ...resetEvent,
      id: "evt_pg_reset_duplicate",
      payload: { ok: false },
      createdAt: "2026-07-04T00:05:02.000Z"
    };
    const artifact: AgentTaskArtifact = {
      id: "art_pg",
      taskId: task.id,
      fileId: "file_pg",
      name: "readme.md",
      bytes: 12,
      createdAt: "2026-07-04T00:06:00.000Z"
    };

    assert.equal(await store.countUsers(), 0);
    assert.deepEqual(await store.createUser(user), {
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    });
    assert.equal(await store.countUsers(), 1);
    assert.equal((await store.findUserByEmail("user@example.test"))?.id, user.id);
    assert.deepEqual(await store.createSession({
      id: "sess_pg",
      userId: user.id,
      csrfToken: "csrf_pg",
      createdAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-07-04T12:00:00.000Z"
    }), {
      id: "sess_pg",
      userId: user.id,
      csrfToken: "csrf_pg",
      createdAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-07-04T12:00:00.000Z"
    });
    assert.equal((await store.findSession("sess_pg"))?.csrfToken, "csrf_pg");
    assert.equal(await store.deleteSession("sess_pg"), true);
    assert.equal(await store.findSession("sess_pg"), null);
    assert.equal(await store.deleteSession("sess_pg"), false);

    await store.createWorkspace(workspace);
    await store.createProject(project);
    await store.createEndpoint(endpoint);
    await store.createTask(task);
    assert.equal(
      (await store.updateTaskStatusIfStarting(task.id, "running", "2026-07-04T00:07:00.000Z"))?.status,
      "running"
    );
    assert.equal(await store.updateTaskStatusIfStarting(task.id, "running", "2026-07-04T00:07:01.000Z"), null);
    await store.appendTaskEvents([event, event, resetEvent, duplicateResetEvent]);
    await store.appendTaskArtifacts([artifact, artifact]);

    assert.deepEqual(await store.listWorkspacesForUser(user.id), [workspace]);
    assert.deepEqual(await store.listProjectsForWorkspace(workspace.id), [project]);
    assert.deepEqual(await store.listEndpointsForProject(project.id), [endpoint]);
    assert.equal((await store.findTask(task.id))?.status, "running");
    assert.deepEqual(await store.listTaskEvents(task.id), [event, resetEvent]);
    assert.deepEqual(await store.listTaskArtifacts(task.id), [artifact]);
  });

  it("implements JSON documents and fenced lease semantics", async () => {
    await store.jsonDocs.put("project_settings", "proj_pg", { concurrency: 2, flags: ["fast"] });
    assert.deepEqual(await store.jsonDocs.get("project_settings", "proj_pg"), { concurrency: 2, flags: ["fast"] });
    await store.jsonDocs.delete("project_settings", "proj_pg");
    assert.equal(await store.jsonDocs.get("project_settings", "proj_pg"), null);

    const first = await store.leases.acquire({
      name: "sandbox:task_pg",
      holder: "api-1",
      ttlMs: 1000,
      now: new Date("2026-07-04T00:00:00.000Z"),
      metadata: { phase: "starting" }
    });
    assert.equal(first.acquired, true);
    assert.equal(first.lease?.fencingToken, 1);

    const blocked = await store.leases.acquire({
      name: "sandbox:task_pg",
      holder: "api-2",
      ttlMs: 1000,
      now: new Date("2026-07-04T00:00:00.500Z")
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.lease?.holder, "api-1");

    assert.equal(await store.leases.compareAndSet("sandbox:task_pg", 0, { phase: "running" }), false);
    assert.equal(await store.leases.compareAndSet("sandbox:task_pg", 1, { phase: "running" }), true);
    assert.equal(await store.leases.renew("sandbox:task_pg", 1, 2000, new Date("2026-07-04T00:00:01.000Z")), true);
    assert.deepEqual(await store.leases.listExpired(new Date("2026-07-04T00:00:02.000Z")), []);

    const second = await store.leases.acquire({
      name: "sandbox:task_pg",
      holder: "api-2",
      ttlMs: 1000,
      now: new Date("2026-07-04T00:00:04.000Z")
    });
    assert.equal(second.acquired, true);
    assert.equal(second.lease?.fencingToken, 2);
    assert.equal(await store.leases.release("sandbox:task_pg", 1), false);
    assert.equal(await store.leases.release("sandbox:task_pg", 2), true);

    const run = sandboxRun();
    await store.sandboxRuns.put(run);
    assert.deepEqual(await store.sandboxRuns.get(run.runId), run);
    assert.deepEqual((await store.sandboxRuns.listActive()).map((item) => item.runId), [run.runId]);
    assert.equal(
      await store.sandboxRuns.updateWithFencing(run.runId, 0, { ...run, phase: "running", fencingToken: 2 }),
      null
    );
    const updated = await store.sandboxRuns.updateWithFencing(run.runId, 1, {
      ...run,
      phase: "running",
      fencingToken: 2
    });
    assert.equal(updated?.phase, "running");
  });
});

function sandboxRun(overrides: Partial<SandboxRunState> = {}): SandboxRunState {
  return {
    workspaceId: "ws_pg",
    projectId: "proj_pg",
    taskId: "task_pg",
    runId: "run_pg",
    namespace: "agentsmith",
    phase: "starting",
    image: "agentsmith-lite/botified-runner:test",
    pvcName: "agentsmith-lite-files",
    projectSubPath: "workspaces/ws_pg/projects/proj_pg",
    botifiedPort: 3099,
    resourceNames: {
      pod: "asl-task-task_pg",
      service: "asl-task-task_pg",
      configMap: "asl-task-task_pg-config",
      secret: "asl-botified-task_pg",
      serviceAccount: "asl-task-task_pg",
      networkPolicy: "asl-task-task_pg"
    },
    serviceKeySecretRef: {
      name: "asl-botified-task_pg",
      key: "BOTIFIED_SERVICE_KEY"
    },
    directories: {
      taskHome: "/workspace/project/tasks/task_pg/home",
      artifacts: "/workspace/project/tasks/task_pg/artifacts",
      botified: "/workspace/project/tasks/task_pg/botified"
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
