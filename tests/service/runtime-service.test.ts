import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { RuntimeService } from "../../packages/application/src/runtimeService.js";
import type { SandboxReapInput } from "../../packages/application/src/sandboxLifecycleService.js";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import type { } from "../../packages/openai-compatible-client/src/index.js";
import {
  type BotifiedAbortResult,
  type BotifiedDeliveryMessageInput,
  type BotifiedDeliveryReceipt,
  type BotifiedDownloadFileResult,
  type BotifiedPostMessageResult,
  type BotifiedRuntimeHttpClient,
  type BotifiedTimelineReadResult,
  type BotifiedUploadFileInput,
  type BotifiedUploadFileResult
} from "../../packages/ports/src/botified.js";
import type {
  KubernetesResourceRef,
  PodReadiness,
  SandboxKubernetesMutationPort,
  SandboxKubernetesReadinessPort
} from "../../packages/sandbox-controller/src/kubernetesPort.js";

describe("live sandbox runtime service", () => {
  it("runs provider maintenance without a live sandbox", async () => {
    let expired = 0;
    const runtime = new RuntimeService(
      { async syncActiveTasksOnce() { return { activeTaskCount: 0, syncedTaskIds: [], failedTaskIds: [] }; } },
      { async reapSandboxRunsOnce(input: SandboxReapInput) { return emptyReapResult(input); } },
      { async expireProviderReservations() { expired += 1; } }
    );
    await runtime.tickOnce();
    assert.equal(expired, 1);
  });
  it("recovers a restarted stopping task as cancelled before fenced cleanup", async () => {
    const botified = new FakeBotifiedClient([{ status: "ok", events: [], nextCursor: "c0" }]);
    const livePort = new FakeLiveSandboxPort();
    const { services, store, userId, projectId, endpointId } = await setupRuntimeServices(botified, livePort);
    const task = await services.tasks.createTask(userId, projectId, { prompt: "cancel after restart", endpointId });
    const run = await store.sandboxRuns.get(task.runId);
    assert.ok(run);
    await store.updateTaskStatusIfNonterminal(task.id, "stopping", task.updatedAt);
    await store.sandboxRuns.updateWithFencing(run!.runId, run!.fencingToken, { ...run!, phase: "stopping", cleanupStatus: "cleanup_requested", fencingToken: run!.fencingToken + 1, updatedAt: task.updatedAt });
    livePort.removePod();
    const runtime = new RuntimeService(services.tasks, services.sandboxLifecycle);
    await runtime.tickOnce();
    const finalized = await store.findTask(task.id);
    assert.equal(finalized?.terminalReason, "cancelled");
    assert.equal(finalized?.artifactProjectionStatus, "draining");
    assert.equal(finalized?.cleanupStatus, "pending");
    assert.equal((await store.findProjectResourceUsage(projectId))?.activeTasks, 0);
    assert.deepEqual((await store.listProjectAuditEvents(projectId)).filter((event)=>event.resourceId===task.id).map((event)=>event.action),["task.create","task.cancel"]);
    await runtime.tickOnce();
    assert.equal((await store.findTask(task.id))?.status, "cancelled");
    assert.equal((await store.findTask(task.id))?.cleanupStatus, "completed");
    assert.equal(await store.sandboxRuns.get(task.runId), null);
  });
  it("keeps a pending terminal failure nonterminal so a later sync can complete and persist its artifact", async () => {
    const botified = new FakeBotifiedClient([
      { status: "ok", events: [], nextCursor: "c0" },
      new Error("Botified transport unavailable"),
      new Error("Botified transport unavailable"),
      {
        status: "ok",
        events: [
          { cursor: "c1", seq: 1, session_id: "s1", type: "file.published", payload: { file_id: "recovered-file", filename: "recovered.txt", size_bytes: 0 } },
          { cursor: "c2", seq: 2, session_id: "s1", type: "cycle.completed", payload: { ok: true } }
        ],
        nextCursor: "c2"
      }
    ]);
    const livePort = new FakeLiveSandboxPort();
    const { services, store, userId, projectId, endpointId } = await setupRuntimeServices(botified, livePort);
    const task = await services.tasks.createTask(userId, projectId, { prompt: "recover after crash", endpointId });
    await services.tasks.syncActiveTasksOnce();
    await services.tasks.syncActiveTasksOnce();
    livePort.markPodFailed();
    const runtime = new RuntimeService(services.tasks, services.sandboxLifecycle);

    await runtime.tickOnce();
    assert.equal((await store.findTask(task.id))?.status, "running");
    assert.equal((await store.sandboxRuns.get(task.runId))?.terminalFailure?.syncStatus, "pending");

    await runtime.tickOnce();
    assert.equal((await store.findTask(task.id))?.status, "completed");
    assert.deepEqual((await store.listTaskArtifacts(task.id)).map((artifact) => artifact.fileId), ["recovered-file"]);
    assert.equal((await store.findTask(task.id))?.cleanupStatus, "completed");
    assert.equal(await store.sandboxRuns.get(task.runId), null);
  });

  it("keeps a failed Pod when the final artifact tail remains unavailable", async () => {
    const botified = new FakeBotifiedClient([
      { status: "ok", events: [], nextCursor: "c0" },
      new Error("Botified transport unavailable"),
      new Error("Botified transport unavailable"),
      new Error("Botified transport unavailable"),
      new Error("Botified transport unavailable"),
      new Error("Botified transport unavailable"),
      new Error("Botified transport unavailable"),
      new Error("Botified transport unavailable"),
      new Error("Botified transport unavailable"),
      new Error("Botified transport unavailable"),
      new Error("Botified transport unavailable")
    ]);
    const livePort = new FakeLiveSandboxPort();
    const { services, store, userId, projectId, endpointId } = await setupRuntimeServices(botified, livePort);
    const task = await services.tasks.createTask(userId, projectId, { prompt: "crash after ready", endpointId });
    await services.tasks.syncActiveTasksOnce();
    await services.tasks.syncActiveTasksOnce();
    livePort.markPodFailed();
    const runtime = new RuntimeService(services.tasks, services.sandboxLifecycle);

    await runtime.tickOnce();
    const firstRun = await store.sandboxRuns.get(task.runId);
    assert.equal(firstRun?.terminalFailure?.reason, "pod_failed");
    assert.equal(firstRun?.terminalFailure?.syncAttempts, 1);
    assert.equal(firstRun?.terminalFailure?.syncStatus, "pending");
    assert.match(firstRun?.terminalFailure?.lastSyncError ?? "", /Botified transport unavailable/);
    assert.deepEqual(livePort.deletedRefs, []);

    await runtime.tickOnce();
    assert.equal((await store.sandboxRuns.get(task.runId))?.terminalFailure?.syncAttempts, 2);
    assert.deepEqual(livePort.deletedRefs, []);

    await runtime.tickOnce();
    const run = await store.sandboxRuns.get(task.runId);
    assert.equal(run?.terminalFailure?.syncStatus, "unavailable");
    assert.equal(run?.terminalFailure?.syncAttempts, 3);
    assert.equal((await store.findTask(task.id))?.status, "failed");
    assert.equal((await store.findTask(task.id))?.terminalReason, "failed");
    assert.equal(run?.cleanupStatus, "cleanup_requested");
    await runtime.tickOnce();
    assert.equal((await store.findTask(task.id))?.artifactProjectionStatus, "failed");
    assert.equal((await store.findTask(task.id))?.cleanupStatus, "pending");
    assert.deepEqual(livePort.deletedRefs, []);
  });

  it("syncs active task timelines and reaps terminal sandboxes in one tick", async () => {
    const botified = new FakeBotifiedClient([
      { status: "ok", events: [], nextCursor: "c0" },
      {
        status: "ok",
        events: [
          { cursor: "c1", seq: 1, session_id: "s1", type: "cycle.completed", payload: { ok: true } }
        ],
        nextCursor: "c1"
      }
    ]);
    const livePort = new FakeLiveSandboxPort();
    const { services, store, userId, projectId, endpointId } = await setupRuntimeServices(botified, livePort);
    const task = await services.tasks.createTask(userId, projectId, { prompt: "finish later", endpointId });
    await services.tasks.syncActiveTasksOnce();
    await services.tasks.syncActiveTasksOnce();
    assert.equal((await store.findTask(task.id))?.status, "running");

    const runtime = new RuntimeService(services.tasks, services.sandboxLifecycle);
    const result = await runtime.tickOnce();

    assert.equal(result.taskSync.activeTaskCount, 1);
    assert.deepEqual(result.taskSync.syncedTaskIds, [task.id]);
    assert.deepEqual(result.taskSync.failedTaskIds, []);
    assert.equal(result.sandboxReap.dryRun, false);
    assert.deepEqual(result.sandboxReap.errors, []);
    assert.equal((await store.findTask(task.id))?.status, "completed");
    assert.equal((await store.findTask(task.id))?.cleanupStatus, "completed");
    assert.equal(await store.sandboxRuns.get(task.runId), null);
    assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), ["post-cursor", "c0", "c1", "c1"]);
    assert.deepEqual(livePort.deletedRefs.map((ref) => ref.kind), [
      "Pod",
      "Service",
      "NetworkPolicy",
      "ConfigMap",
      "Secret",
      "ServiceAccount"
    ]);
  });

  it("keeps syncing later active tasks and still reaps when one timeline read fails", async () => {
    const botified = new FakeBotifiedClient([
      { status: "ok", events: [], nextCursor: "task1-c0" },
      { status: "ok", events: [], nextCursor: "task2-c0" },
      new Error("first task timeline unavailable"),
      {
        status: "ok",
        events: [
          { cursor: "task2-c1", seq: 1, session_id: "s2", type: "cycle.completed", payload: { ok: true } }
        ],
        nextCursor: "task2-c1"
      }
    ]);
    const livePort = new FakeLiveSandboxPort();
    const { services, store, userId, projectId, endpointId } = await setupRuntimeServices(botified, livePort);
    const firstTask = await services.tasks.createTask(userId, projectId, { prompt: "first", endpointId });
    const secondTask = await services.tasks.createTask(userId, projectId, { prompt: "second", endpointId });
    await services.tasks.syncActiveTasksOnce();
    await services.tasks.syncActiveTasksOnce();

    const runtime = new RuntimeService(services.tasks, services.sandboxLifecycle);
    const result = await runtime.tickOnce();

    assert.equal(result.taskSync.activeTaskCount, 2);
    assert.deepEqual(result.taskSync.syncedTaskIds, [secondTask.id]);
    assert.deepEqual(result.taskSync.failedTaskIds, [firstTask.id]);
    assert.equal((await store.findTask(firstTask.id))?.status, "running");
    assert.equal((await store.findTask(secondTask.id))?.status, "completed");
    assert.deepEqual(result.sandboxReap.errors, []);
    assert.equal((await store.findTask(secondTask.id))?.cleanupStatus, "completed");
    assert.equal(await store.sandboxRuns.get(secondTask.runId), null);
    assert.ok(livePort.listManagedResourcesCalls > 0, "tick should run the sandbox reaper even after a task sync error");
  });

  it("starts with an immediate tick, skips overlapping ticks, and stops the interval loop", async () => {
    const callbacks: Array<() => void> = [];
    const clearedTimers: unknown[] = [];
    let taskSyncCalls = 0;
    let reapCalls = 0;
    let releaseFirstSync: (() => void) | undefined;
    const firstSyncCanFinish = new Promise<void>((resolve) => {
      releaseFirstSync = resolve;
    });
    const runtime = new RuntimeService(
      {
        async syncActiveTasksOnce() {
          taskSyncCalls += 1;
          if (taskSyncCalls === 1) {
            await firstSyncCanFinish;
          }
          return { activeTaskCount: 0, syncedTaskIds: [], failedTaskIds: [] };
        }
      },
      {
        async reapSandboxRunsOnce(input: SandboxReapInput) {
          reapCalls += 1;
          return {
            namespace: "agentsmith",
            runCounts: {
              total: 0,
              active: 0,
              cleanupRequested: 0,
              deleting: 0,
              cleaned: 0,
              starting: 0,
              running: 0,
              stopping: 0,
              expired: 0
            },
            activeTaskCount: 0,
            observedResourceCounts: {},
            cleanupPlan: { targets: [], recentFailures: [] },
            recentCleanupFailures: [],
            actionSummary: [],
            errors: [],
            dryRun: input.apply !== true,
            storedRunIds: []
          };
        }
      },
      {
        tickIntervalMs: 25,
        setInterval(callback, intervalMs) {
          assert.equal(intervalMs, 25);
          callbacks.push(callback);
          return "timer";
        },
        clearInterval(timer) {
          clearedTimers.push(timer);
        }
      }
    );

    runtime.startLoop();
    runtime.startLoop();
    assert.equal(callbacks.length, 1);
    assert.equal(taskSyncCalls, 1);
    assert.equal(reapCalls, 0);

    callbacks[0]?.();
    await flushAsyncWork();
    assert.equal(taskSyncCalls, 1);
    assert.equal(reapCalls, 0);

    releaseFirstSync?.();
    await flushAsyncWork();
    assert.equal(taskSyncCalls, 1);
    assert.equal(reapCalls, 1);

    callbacks[0]?.();
    await flushAsyncWork();
    assert.equal(taskSyncCalls, 2);
    assert.equal(reapCalls, 2);

    runtime.stopLoop();
    runtime.stopLoop();
    assert.deepEqual(clearedTimers, ["timer"]);
  });

  it("keeps a successful task sync result when the independent sandbox reap fails", async () => {
    const runtime = new RuntimeService(
      { async syncActiveTasksOnce() { return { activeTaskCount: 1, syncedTaskIds: ["task-ok"], failedTaskIds: [] }; } },
      { async reapSandboxRunsOnce() { throw new Error("kubernetes unavailable"); } }
    );
    const result = await runtime.tickOnce();
    assert.deepEqual(result.taskSync.syncedTaskIds, ["task-ok"]);
    assert.deepEqual(result.sandboxReap.errors, ["Sandbox reap failed"]);
  });
});

function emptyReapResult(input: SandboxReapInput) {
  return { namespace: "agentsmith", runCounts: { total: 0, active: 0, cleanupRequested: 0, deleting: 0, cleaned: 0, starting: 0, running: 0, stopping: 0, expired: 0 }, activeTaskCount: 0, observedResourceCounts: {}, cleanupPlan: { targets: [], recentFailures: [] }, recentCleanupFailures: [], actionSummary: [], errors: [], dryRun: input.apply !== true, storedRunIds: [] };
}

async function setupRuntimeServices(botified: FakeBotifiedClient, livePort: FakeLiveSandboxPort) {
  const store = createLocalInMemoryProductStore();
  const services = createApplicationServices({
    store,
    dataRoot: path.join(tmpdir(), "agentsmith-lite-runtime-service"),
    builtinAdminPassword: "test-admin-password",
    sessionSecret: "test-session-secret-at-least-32-chars",
    botifiedClient: botified,
    providerClient: {
      async validateEndpoint() { return { status: "healthy" as const }; },
      async completeChat() { throw new Error("not used"); }
    },
    botifiedServiceKeyFactory: () => "test-service-key",
    liveSandbox: {
      port: livePort,
      sleep: livePort.sleep
    }
  });
  const { user } = await services.auth.loginAfterBootstrap("test-admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
  const credential = await services.credentials.create(user.id, project.id, { name: "openai-compatible", baseUrl: "https://models.example.com/v1", secret: "sk-real-model-key" });
  const endpoint = await services.endpoints.createEndpoint(user.id, project.id, {
    name: "openai-compatible",
    protocol: "openai_chat_completions",
    baseUrl: "https://models.example.com/v1",
    model: "gpt-compatible",
    credentialId: credential.id,
    capabilities: ["text", "tool_calls"],
    requestTimeoutSecs: 45
  });

  return {
    services,
    store,
    userId: user.id,
    projectId: project.id,
    endpointId: endpoint.id
  };
}

class FakeBotifiedClient implements BotifiedRuntimeHttpClient {
  readonly postMessageCalls: Array<{ baseUrl: string; serviceKey: string; message: string }> = [];
  readonly readTimelineCalls: Array<{ baseUrl: string; serviceKey: string; cursor: string | undefined }> = [];

  constructor(private readonly timelineReads: Array<BotifiedTimelineReadResult | Error>) {}

  async health(): Promise<{ status: "ok" }> {
    return { status: "ok" };
  }

  async postMessage(baseUrl: string, serviceKey: string, message: string): Promise<BotifiedPostMessageResult> {
    this.postMessageCalls.push({ baseUrl, serviceKey, message });
    return { accepted: true, messageId: "msg_1", cursor: "post-cursor" };
  }

  async postMessageWithDelivery(baseUrl: string, serviceKey: string, input: BotifiedDeliveryMessageInput): Promise<BotifiedDeliveryReceipt> {
    const posted = await this.postMessage(baseUrl, serviceKey, input.text);
    return { accepted: posted.accepted, deliveryKey: input.deliveryKey, requestHash: input.requestHash, ...(posted.messageId ? { messageId: posted.messageId } : {}), ...(posted.cursor ? { cursor: posted.cursor } : {}) };
  }

  async queryDeliveryReceipt(): Promise<BotifiedDeliveryReceipt | null> {
    return null;
  }

  async readState() {
    return { snapshot: {}, state: "running" };
  }

  async readTimeline(baseUrl: string, serviceKey: string, cursor?: string): Promise<BotifiedTimelineReadResult> {
    this.readTimelineCalls.push({ baseUrl, serviceKey, cursor });
    const next = this.timelineReads.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (next) {
      return next;
    }
    const result: BotifiedTimelineReadResult = { status: "ok", events: [] };
    if (cursor !== undefined) {
      result.nextCursor = cursor;
    }
    return result;
  }

  async uploadFile(_baseUrl: string, _serviceKey: string, _file: BotifiedUploadFileInput): Promise<BotifiedUploadFileResult> {
    return { files: [] };
  }

  async downloadFile(_baseUrl: string, _serviceKey: string, _fileId: string): Promise<BotifiedDownloadFileResult> {
    return { bytes: new Uint8Array(), sizeBytes: 0 };
  }

  async abort(_baseUrl: string, _serviceKey: string): Promise<BotifiedAbortResult> {
    return { aborted: true };
  }
}


class FakeLiveSandboxPort implements SandboxKubernetesMutationPort, SandboxKubernetesReadinessPort {
  readonly appliedResources: KubernetesResource[] = [];
  readonly deletedRefs: KubernetesResourceRef[] = [];
  readonly sleeps: number[] = [];
  listManagedResourcesCalls = 0;
  readonly sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
  };

  private readonly readiness: PodReadiness[] = ["ready"];
  private resources: KubernetesResource[] = [];

  async listManagedResources(): Promise<KubernetesResource[]> {
    this.listManagedResourcesCalls += 1;
    return this.resources.map((resource) => structuredClone(resource));
  }

  async applyResource(resource: KubernetesResource, expectedLabels: Record<string, string>): Promise<"applied" | "fence_mismatch"> {
    if (!hasLabels(resource, expectedLabels)) {
      return "fence_mismatch";
    }
    this.appliedResources.push(structuredClone(resource));
    this.resources = this.resources.filter((candidate) => !sameRef(candidate, resourceRef(resource)));
    this.resources.push(structuredClone(resource));
    return "applied";
  }

  async deleteResource(ref: KubernetesResourceRef, expectedLabels: Record<string, string>): Promise<"deleted" | "not_found" | "fence_mismatch"> {
    this.deletedRefs.push(structuredClone(ref));
    const resource = this.resources.find((candidate) => sameRef(candidate, ref));
    if (!resource) {
      return "not_found";
    }
    if (!hasLabels(resource, expectedLabels)) {
      return "fence_mismatch";
    }
    this.resources = this.resources.filter((candidate) => !sameRef(candidate, ref));
    return "deleted";
  }

  async getPodReadiness(): Promise<PodReadiness> {
    return this.readiness.shift() ?? "ready";
  }

  markPodFailed(): void {
    const pod = this.resources.find((resource) => resource.kind === "Pod");
    assert.ok(pod);
    pod.status = { phase: "Failed" };
  }

  removePod(): void {
    this.resources = this.resources.filter((resource) => resource.kind !== "Pod");
  }
}

function resourceRef(resource: KubernetesResource): KubernetesResourceRef {
  assert.ok(resource.metadata.namespace);
  assert.ok(
    resource.kind === "Pod" ||
      resource.kind === "Service" ||
      resource.kind === "Secret" ||
      resource.kind === "ConfigMap" ||
      resource.kind === "ServiceAccount" ||
      resource.kind === "NetworkPolicy"
  );
  return {
    kind: resource.kind,
    namespace: resource.metadata.namespace,
    name: resource.metadata.name
  };
}

function sameRef(resource: KubernetesResource, ref: KubernetesResourceRef): boolean {
  return resource.kind === ref.kind && resource.metadata.namespace === ref.namespace && resource.metadata.name === ref.name;
}

function hasLabels(resource: KubernetesResource, expectedLabels: Record<string, string>): boolean {
  return Object.entries(expectedLabels).every(([key, value]) => resource.metadata.labels[key] === value);
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
