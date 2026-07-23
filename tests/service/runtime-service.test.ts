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

  it("waits for the Botified service after the Pod becomes ready", async () => {
    const botified = new FakeBotifiedClient([], [
      new Error("service endpoint is not ready"),
      new Error("service endpoint is not ready"),
      { status: "ok" }
    ]);
    const livePort = new FakeLiveSandboxPort();
    const { services, store, userId, projectId, endpointId } = await setupRuntimeServices(botified, livePort);
    const task = await services.tasks.createTask(userId, projectId, taskInput("wait for service", endpointId));

    await services.tasks.syncActiveTasksOnce();

    assert.equal((await services.tasks.getTaskDetail(userId,task.id)).lifecycle.state,"active");
    assert.equal((await store.listTaskMessages(task.id))[0]?.deliveryStatus, "accepted");
    assert.equal(botified.healthCalls.length, 3);
    assert.equal(botified.postMessageCalls.length, 1);
    assert.deepEqual(livePort.sleeps, [1000, 1000]);
    assert.equal((await store.sandboxRuns.get(task.runId))?.startupFailure, undefined);
  });

  it("settles startup cleanup through RuntimeService without starting usage before Pod readiness",async()=>{
    const botified=new FakeBotifiedClient([]);
    const livePort=new FakeLiveSandboxPort();
    livePort.queueReadiness("failed");
    const {services,store,userId,projectId,endpointId}=await setupRuntimeServices(botified,livePort,{readinessTimeoutMs:0,taskRetryDelayMs:0});
    const task=await services.tasks.createTask(userId,projectId,taskInput("Pod fails early",endpointId));

    const runtime=new RuntimeService(services.tasks,services.sandboxLifecycle);
    await runtime.tickOnce();

    const failedRun=await store.sandboxRuns.get(task.runId);
    assert.equal(failedRun?.startedAt,null);
    assert.equal(failedRun?.phase,"cleaned");
    assert.equal(failedRun?.cleanupStatus,"cleaned");
    assert.equal(failedRun?.releaseReason,"failed");
    assert.ok(failedRun?.startupFailure);
    assert.equal((await store.listTaskMessages(task.id))[0]?.deliveryStatus,"failed");
    assert.equal((await store.findTask(task.id))?.activeReservation,false);
    const settlements=await store.listSandboxUsageSettlements(projectId,userId);
    assert.equal(settlements.length,1);
    assert.equal(settlements[0]?.startedAt,null);
    assert.equal(settlements[0]?.durationSeconds,0);
    await runtime.tickOnce();
    assert.equal((await store.listSandboxUsageSettlements(projectId,userId)).length,1);
    assert.equal((await store.listProjectAuditEvents(projectId)).filter((event)=>event.action==="sandbox.started").length,0);
  });

  it("settles startup cleanup through RuntimeService while retaining Pod-ready usage start",async()=>{
    const botified=new FakeBotifiedClient([],[new Error("service endpoint is not ready")]);
    const livePort=new FakeLiveSandboxPort();
    const {services,store,userId,projectId,endpointId}=await setupRuntimeServices(botified,livePort,{readinessTimeoutMs:0,taskRetryDelayMs:0});
    const task=await services.tasks.createTask(userId,projectId,taskInput("Botified starts late",endpointId));

    const runtime=new RuntimeService(services.tasks,services.sandboxLifecycle);
    await runtime.tickOnce();
    const afterFailure=await store.sandboxRuns.get(task.runId);
    assert.ok(afterFailure?.startedAt);
    assert.equal(afterFailure.phase,"cleaned");
    assert.equal(afterFailure.cleanupStatus,"cleaned");
    assert.equal(afterFailure.releaseReason,"failed");
    assert.ok(afterFailure.startupFailure);
    assert.equal((await store.listTaskMessages(task.id))[0]?.deliveryStatus,"failed");
    assert.equal((await store.findTask(task.id))?.activeReservation,false);
    const settlements=await store.listSandboxUsageSettlements(projectId,userId);
    assert.equal(settlements.length,1);
    assert.equal(settlements[0]?.startedAt,afterFailure.startedAt);

    await runtime.tickOnce();
    assert.equal((await store.sandboxRuns.get(task.runId))?.startedAt,afterFailure.startedAt);
    assert.equal((await store.listSandboxUsageSettlements(projectId,userId)).length,1);
    assert.equal(botified.healthCalls.length,1);
    assert.equal(botified.postMessageCalls.length,0);
    assert.equal((await store.listProjectAuditEvents(projectId)).filter((event)=>event.action==="sandbox.started").length,1);
  });

  it("syncs active task timelines without reaping a completed turn sandbox", async () => {
    const botified = new FakeBotifiedClient([
      { status: "ok", events: [], nextCursor: "evt_s1_0" },
      { status: "ok", events: [], nextCursor: "evt_s1_0" },
      {
        status: "ok",
        events: [
          timelineEvent(1, "s1", "cycle.completed", { ok: true })
        ],
        nextCursor: "evt_s1_1"
      }
    ]);
    const livePort = new FakeLiveSandboxPort();
    const { services, store, userId, projectId, endpointId } = await setupRuntimeServices(botified, livePort);
    const task = await services.tasks.createTask(userId, projectId, taskInput("finish later", endpointId));
    await services.tasks.syncActiveTasksOnce();
    await services.tasks.syncActiveTasksOnce();
    assert.equal((await services.tasks.getTaskDetail(userId,task.id)).lifecycle.state,"active");

    const runtime = new RuntimeService(services.tasks, services.sandboxLifecycle);
    const result = await runtime.tickOnce();

    assert.equal(result.taskSync.activeTaskCount, 1);
    assert.deepEqual(result.taskSync.syncedTaskIds, [task.id]);
    assert.deepEqual(result.taskSync.failedTaskIds, []);
    assert.equal(result.sandboxReap.dryRun, false);
    assert.deepEqual(result.sandboxReap.errors, []);
    assert.equal((await services.tasks.getTaskDetail(userId,task.id)).lifecycle.state,"active");
    assert.equal((await store.findTask(task.id))?.terminalReason, null);
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "active");
    assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), [undefined, "evt_s1_0", "evt_s1_0", "evt_s1_1"]);
    assert.deepEqual(livePort.deletedRefs, []);
  });

  it("keeps syncing later active tasks and still reaps when one timeline read fails", async () => {
    const botified = new FakeBotifiedClient([]);
    const livePort = new FakeLiveSandboxPort();
    const { services, store, userId, projectId, endpointId } = await setupRuntimeServices(botified, livePort);
    const firstTask = await services.tasks.createTask(userId, projectId, taskInput("first", endpointId));
    const secondTask = await services.tasks.createTask(userId, projectId, taskInput("second", endpointId));
    await services.tasks.syncActiveTasksOnce();
    await services.tasks.syncActiveTasksOnce();
    botified.queueTimelineReads(firstTask.id, [new Error("first task timeline unavailable")]);
    botified.queueTimelineReads(secondTask.id, [{
      status: "ok",
      events: [timelineEvent(1, secondTask.id, "cycle.completed", { ok: true })],
      nextCursor: `evt_${secondTask.id.replace(/[^A-Za-z0-9]/g, "").toLowerCase()}_1`
    }]);

    const runtime = new RuntimeService(services.tasks, services.sandboxLifecycle);
    const result = await runtime.tickOnce();

    assert.equal(result.taskSync.activeTaskCount, 2);
    assert.deepEqual(result.taskSync.syncedTaskIds, [secondTask.id]);
    assert.deepEqual(result.taskSync.failedTaskIds, [firstTask.id]);
    assert.equal((await services.tasks.getTaskDetail(userId,firstTask.id)).lifecycle.state,"active");
    assert.equal((await services.tasks.getTaskDetail(userId,secondTask.id)).lifecycle.state,"active");
    assert.deepEqual(result.sandboxReap.errors, []);
    assert.equal((await store.sandboxRuns.get(secondTask.runId))?.cleanupStatus, "active");
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

function timelineEvent(seq: number, sessionId: string, type: string, data: Record<string, unknown>) {
  return {
    version: "botified.timeline.v1",
    seq,
    cursor: `evt_${sessionId}_${seq}`,
    time: "2026-07-18T00:00:00.000Z",
    session_id: sessionId,
    type,
    trace: { cycle_id: `cycle_${sessionId}` },
    item: null,
    data
  };
}

function emptyReapResult(input: SandboxReapInput) {
  return { namespace: "agentsmith", runCounts: { total: 0, active: 0, cleanupRequested: 0, deleting: 0, cleaned: 0, starting: 0, running: 0, stopping: 0, expired: 0 }, activeTaskCount: 0, observedResourceCounts: {}, cleanupPlan: { targets: [], recentFailures: [] }, recentCleanupFailures: [], actionSummary: [], errors: [], dryRun: input.apply !== true, storedRunIds: [] };
}

function taskInput(prompt: string, endpointId: string) {
  return { prompt, endpointId, fileLibrary: { mode: "create_new" as const, name: `Library ${prompt}` } };
}

async function setupRuntimeServices(botified:FakeBotifiedClient,livePort:FakeLiveSandboxPort,options:{readinessTimeoutMs?:number;taskRetryDelayMs?:number}={}) {
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
    ...(options.taskRetryDelayMs!==undefined?{taskRetryDelayMs:options.taskRetryDelayMs}:{}),
    botifiedBaseUrlForTask: ({taskId}) => `http://botified.test/${taskId}`,
    liveSandbox: {
      port: livePort,
      sleep: livePort.sleep,
      ...(options.readinessTimeoutMs!==undefined?{readinessTimeoutMs:options.readinessTimeoutMs}:{})
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
  readonly healthCalls: string[] = [];
  readonly postMessageCalls: Array<{ baseUrl: string; serviceKey: string; message: string }> = [];
  readonly readTimelineCalls: Array<{ baseUrl: string; serviceKey: string; cursor: string | undefined }> = [];
  private readonly timelineCursors = new Map<string, string | undefined>();
  private readonly taskTimelineReads = new Map<string, Array<BotifiedTimelineReadResult | Error>>();

  constructor(
    private readonly timelineReads: Array<BotifiedTimelineReadResult | Error>,
    private readonly healthReads: Array<{ status: "ok" } | Error> = [{ status: "ok" }]
  ) {}

  queueTimelineReads(taskId: string, reads: Array<BotifiedTimelineReadResult | Error>): void {
    this.taskTimelineReads.set(taskId, [...reads]);
  }

  async health(baseUrl: string): Promise<{ status: "ok" }> {
    this.healthCalls.push(baseUrl);
    const next = this.healthReads.shift() ?? { status: "ok" as const };
    if (next instanceof Error) throw next;
    return next;
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

  async readState(baseUrl: string, _serviceKey: string) {
    const timelineCursor = this.timelineCursors.get(baseUrl);
    return {
      snapshot: {
        queue_length: 0,
        tasks: { running: 0, cancelling: 0, pending_callbacks: 0, pending_asks: 0 },
        active_items: []
      },
      state: "idle" as const,
      sessionId: sessionIdFromTestBaseUrl(baseUrl),
      ...(timelineCursor ? { timelineCursor } : {}),
      activeItems: [] as unknown[]
    };
  }

  async readTimeline(baseUrl: string, serviceKey: string, cursor?: string): Promise<BotifiedTimelineReadResult> {
    this.readTimelineCalls.push({ baseUrl, serviceKey, cursor });
    const sessionId = sessionIdFromTestBaseUrl(baseUrl);
    const taskReads = this.taskTimelineReads.get(sessionId);
    const next = taskReads?.shift() ?? this.timelineReads.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (next) {
      this.timelineCursors.set(baseUrl, next.nextCursor);
      if (next.status === "gap") return next;
      return {
        ...next,
        events: next.events.map((event) => {
          const timeline = event as ReturnType<typeof timelineEvent>;
          return {...timeline,session_id:sessionId,cursor:`evt_${sessionId.replace(/[^A-Za-z0-9]/g,"").toLowerCase()}_${timeline.seq}`};
        })
      };
    }
    const result: BotifiedTimelineReadResult = { status: "ok", events: [] };
    if (cursor !== undefined) {
      result.nextCursor = cursor;
    }
    this.timelineCursors.set(baseUrl, result.nextCursor);
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

function sessionIdFromTestBaseUrl(baseUrl:string):string{
  const sessionId=new URL(baseUrl).pathname.slice(1);
  assert.ok(sessionId);
  return sessionId;
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

  queueReadiness(...readiness:PodReadiness[]):void {
    this.readiness.splice(0,this.readiness.length,...readiness);
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
