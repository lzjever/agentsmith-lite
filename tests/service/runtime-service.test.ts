import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import { RuntimeService } from "../../packages/application/src/runtimeService.js";
import type { SandboxReapInput } from "../../packages/application/src/sandboxLifecycleService.js";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import type { ModelCredential, ModelCredentialResolver } from "../../packages/openai-compatible-client/src/index.js";
import {
  type BotifiedAbortResult,
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
    assert.equal(task.status, "running");

    const runtime = new RuntimeService(services.tasks, services.sandboxLifecycle);
    const result = await runtime.tickOnce();

    assert.equal(result.taskSync.activeTaskCount, 1);
    assert.deepEqual(result.taskSync.syncedTaskIds, [task.id]);
    assert.deepEqual(result.taskSync.failedTaskIds, []);
    assert.equal(result.sandboxReap.dryRun, false);
    assert.equal((await store.findTask(task.id))?.status, "completed");
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleaned");
    assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), ["post-cursor", "c0"]);
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

    const runtime = new RuntimeService(services.tasks, services.sandboxLifecycle);
    const result = await runtime.tickOnce();

    assert.equal(result.taskSync.activeTaskCount, 2);
    assert.deepEqual(result.taskSync.syncedTaskIds, [secondTask.id]);
    assert.deepEqual(result.taskSync.failedTaskIds, [firstTask.id]);
    assert.equal((await store.findTask(firstTask.id))?.status, "running");
    assert.equal((await store.findTask(secondTask.id))?.status, "completed");
    assert.equal((await store.sandboxRuns.get(secondTask.runId))?.cleanupStatus, "cleaned");
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
            observedResourceCounts: {},
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
});

async function setupRuntimeServices(botified: FakeBotifiedClient, livePort: FakeLiveSandboxPort) {
  const store = createLocalInMemoryProductStore();
  const services = createApplicationServices({
    store,
    dataRoot: path.join(tmpdir(), "agentsmith-lite-runtime-service"),
    builtinAdminPassword: "admin-password",
    sessionSecret: "test-session-secret",
    botifiedClient: botified,
    botifiedServiceKeyFactory: () => "test-service-key",
    modelCredentialResolver: new FakeCredentialResolver({
      apiKey: "sk-real-model-key",
      baseUrl: "https://models.example.com/v1"
    }),
    liveSandbox: {
      port: livePort,
      sleep: livePort.sleep
    }
  });
  const { user } = await services.auth.loginAfterBootstrap("admin-password");
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
  const endpoint = await services.endpoints.createEndpoint(user.id, project.id, {
    name: "openai-compatible",
    protocol: "openai_chat_completions",
    baseUrl: "https://models.example.com/v1",
    model: "gpt-compatible",
    apiKeySecretRef: "secret/openai",
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

class FakeCredentialResolver implements ModelCredentialResolver {
  readonly calls: string[] = [];

  constructor(private readonly credential: ModelCredential) {}

  resolveCredential(secretRef: string): ModelCredential {
    this.calls.push(secretRef);
    return this.credential;
  }
}

class FakeLiveSandboxPort implements SandboxKubernetesMutationPort, SandboxKubernetesReadinessPort {
  readonly appliedResources: KubernetesResource[] = [];
  readonly deletedRefs: KubernetesResourceRef[] = [];
  readonly patchedRefs: KubernetesResourceRef[] = [];
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

  async patchLabels(
    ref: KubernetesResourceRef,
    expectedLabels: Record<string, string>,
    labels: Record<string, string>
  ): Promise<"patched" | "not_found" | "fence_mismatch"> {
    this.patchedRefs.push(structuredClone(ref));
    const resource = this.resources.find((candidate) => sameRef(candidate, ref));
    if (!resource) {
      return "not_found";
    }
    if (!hasLabels(resource, expectedLabels)) {
      return "fence_mismatch";
    }
    Object.assign(resource.metadata.labels, labels);
    return "patched";
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
