import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices, type CreateApplicationServicesInput } from "../../packages/application/src/factory.js";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import type { ModelCredential, ModelCredentialResolver } from "../../packages/openai-compatible-client/src/index.js";
import {
  BotifiedHttpError,
  type BotifiedAbortResult,
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

describe("task service Botified orchestration", () => {
  it("sends the prompt through Botified, stores projected events, and keeps service keys server-side", async () => {
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          { cursor: "c1", seq: 1, session_id: "s1", type: "input.accepted", payload: { text: "build it" } },
          {
            cursor: "c2",
            seq: 2,
            session_id: "s1",
            type: "assistant_message.completed",
            payload: {
              text: "working with Bearer bsk_timeline_secret and sk-timeline-secret",
              notes: ["safe", "array bsk_array_secret", { nested: "sk-nested-secret" }],
              nested: { apiKey: "sk-field-secret", trace: "Bearer bsk_nested_secret" }
            }
          },
          { cursor: "c3", seq: 3, session_id: "s1", type: "file.published", payload: { file_id: "f1", name: "report.txt", bytes: 12 } }
        ],
        nextCursor: "c3"
      }
    ]);
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified);

    const task = await services.tasks.createTask(userId, projectId, {
      prompt: "build it",
      endpointId
    });

    assert.equal(task.status, "running");
    assert.deepEqual(botified.postMessageCalls, [
      {
        baseUrl: `http://asl-task-${task.id}.agentsmith.svc.cluster.local:3099`,
        serviceKey: "test-service-key",
        message: "build it"
      }
    ]);
    assert.equal(
      task.sandbox.resources.some((resource) =>
        resource.kind === "Secret" &&
        (resource.stringData as Record<string, string> | undefined)?.BOTIFIED_SERVICE_KEY === "<redacted-generated-per-task>"
      ),
      true
    );
    assert.equal(JSON.stringify(task).includes("test-service-key"), false);
    const runtimeState = await store.jsonDocs.get("sandbox_runtime_state", task.id);
    assert.ok(runtimeState, "runtime state should be stored");
    assert.equal("serviceKey" in runtimeState, false);
    assert.equal(JSON.stringify(runtimeState).includes("test-service-key"), false);

    const events = await store.listTaskEvents(task.id);
    assert.deepEqual(events.map((event) => event.kind), ["user_input", "assistant_message", "artifact"]);
    assert.deepEqual(events.map((event) => event.botifiedSeq), [1, 2, 3]);
    assert.equal(events[0]?.payload.text, "build it");
    assert.equal(events[1]?.payload.text, "working with Bearer <redacted> and sk-<redacted>");
    assert.deepEqual(events[1]?.payload.notes, ["safe", "array bsk_<redacted>", { nested: "sk-<redacted>" }]);
    assert.deepEqual(events[1]?.payload.nested, { apiKey: "[redacted]", trace: "Bearer <redacted>" });
    assert.doesNotMatch(
      JSON.stringify(events),
      /bsk_timeline_secret|sk-timeline-secret|bsk_array_secret|sk-nested-secret|sk-field-secret|bsk_nested_secret/
    );
    const artifacts = await store.listTaskArtifacts(task.id);
    assert.deepEqual(artifacts.map((artifact) => [artifact.taskId, artifact.fileId, artifact.name, artifact.bytes]), [
      [task.id, "f1", "report.txt", 12]
    ]);
  });

  it("requires a generated Botified service key before sending messages", async () => {
    const botified = new FakeBotifiedClient([]);
    const { services, userId, projectId, endpointId } = await setupTaskServices(botified, () => "");

    await assert.rejects(
      () => services.tasks.createTask(userId, projectId, { prompt: "hello", endpointId }),
      /Botified service key is required/
    );
    assert.equal(botified.postMessageCalls.length, 0);
  });

  it("keeps dry-run default local and does not resolve model credentials or apply live resources", async () => {
    const botified = new FakeBotifiedClient([]);
    const resolver = new FakeCredentialResolver({
      apiKey: "sk-real-model-key",
      baseUrl: "https://models.example.com/v1"
    });
    const { services, userId, projectId, endpointId } = await setupTaskServices(botified, {
      modelCredentialResolver: resolver
    });

    const task = await services.tasks.createTask(userId, projectId, {
      prompt: "dry run",
      endpointId
    });

    assert.equal(task.status, "running");
    assert.deepEqual(resolver.calls, []);
    assert.equal(botified.postMessageCalls.length, 1);
    assert.equal(JSON.stringify(task).includes("sk-real-model-key"), false);
  });

  it("does not persist or reuse secret-like Botified control cursors", async () => {
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          {
            cursor: "event-bsk_event_cursor_secret",
            seq: 1,
            session_id: "session-sk-session-secret",
            type: "assistant_message.completed Bearer bsk_type_secret",
            payload: { text: "ok" }
          }
        ],
        nextCursor: "next-sk-timeline-secret"
      }
    ], {
      postResult: {
        accepted: true,
        messageId: "msg_1",
        cursor: "post-bsk_post_cursor_secret"
      }
    });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified);

    const task = await services.tasks.createTask(userId, projectId, {
      prompt: "cursor hygiene",
      endpointId
    });
    await services.tasks.listTaskEvents(userId, task.id);

    const runtimeState = await store.jsonDocs.get("sandbox_runtime_state", task.id);
    assert.ok(runtimeState, "runtime state should be stored");
    assert.equal("postMessageCursor" in runtimeState, false);
    assert.equal("timelineCursor" in runtimeState, false);
    assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), [undefined, undefined]);

    const events = await store.listTaskEvents(task.id);
    assert.equal(events[0]?.cursor, "event-bsk_<redacted>");
    assert.equal(events[0]?.botifiedType, "assistant_message.completed Bearer <redacted>");
    assert.equal(events[0]?.sessionId, "session-sk-<redacted>");
    assert.doesNotMatch(
      JSON.stringify({ runtimeState, events }),
      /bsk_event_cursor_secret|sk-session-secret|bsk_type_secret|sk-timeline-secret|bsk_post_cursor_secret/
    );
  });

  it("starts a live sandbox by applying resources, waiting for readiness, then posting the prompt", async () => {
    const operations: string[] = [];
    const botified = new FakeBotifiedClient([], { operations });
    const livePort = new FakeLiveSandboxPort({ operations, readiness: ["ready"] });
    const resolver = new FakeCredentialResolver({
      apiKey: "sk-real-model-key",
      baseUrl: "https://models.example.com/v1/"
    });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
      modelCredentialResolver: resolver,
      liveSandbox: {
        port: livePort,
        readinessTimeoutMs: 1000,
        readinessPollMs: 10,
        sleep: livePort.sleep
      }
    });

    const task = await services.tasks.createTask(userId, projectId, {
      prompt: "live please",
      endpointId
    });

    assert.equal(task.status, "running");
    assert.deepEqual(resolver.calls, ["secret/openai"]);
    assert.deepEqual(livePort.appliedResources.map((resource) => resource.kind), [
      "Secret",
      "ConfigMap",
      "ServiceAccount",
      "NetworkPolicy",
      "Service",
      "Pod"
    ]);
    assert.deepEqual(livePort.deletedRefs, []);
    assert.ok(operations.lastIndexOf("apply:Pod") < operations.indexOf("readiness:asl-task-" + task.id));
    assert.ok(operations.indexOf("readiness:asl-task-" + task.id) < operations.indexOf("post"));

    const appliedSecret = livePort.appliedResources.find((resource) => resource.kind === "Secret") as SecretResource | undefined;
    assert.deepEqual(appliedSecret?.stringData, {
      BOTIFIED_SERVICE_KEY: "test-service-key",
      MODEL_API_KEY: "sk-real-model-key"
    });
    const appliedConfig = livePort.appliedResources.find((resource) => resource.kind === "ConfigMap") as ConfigMapResource | undefined;
    const generatedConfig = JSON.parse(appliedConfig?.data["botified-config.yaml"] ?? "{}") as {
      service?: { port?: number };
      providers?: Array<{ api_key_env?: string }>;
    };
    assert.equal(generatedConfig.service?.port, 3099);
    assert.equal(generatedConfig.providers?.[0]?.api_key_env, "MODEL_API_KEY");
    assert.equal(JSON.stringify(generatedConfig).includes("sk-real-model-key"), false);

    const publicSecret = task.sandbox.resources.find((resource) => resource.kind === "Secret") as SecretResource | undefined;
    assert.deepEqual(publicSecret?.stringData, {
      BOTIFIED_SERVICE_KEY: "<redacted-generated-per-task>",
      MODEL_API_KEY: "<redacted-model-api-key>"
    });
    const returnedJson = JSON.stringify(task);
    assert.equal(returnedJson.includes("test-service-key"), false);
    assert.equal(returnedJson.includes("sk-real-model-key"), false);
    const runtimeState = await store.jsonDocs.get("sandbox_runtime_state", task.id);
    assert.equal(JSON.stringify(runtimeState).includes("test-service-key"), false);
    assert.equal(JSON.stringify(runtimeState).includes("sk-real-model-key"), false);
    const sandboxRun = await store.sandboxRuns.get(task.runId);
    assert.equal(sandboxRun?.phase, "running");
    assert.equal(sandboxRun?.cleanupStatus, "active");
    assert.ok(sandboxRun?.expiresAt, "live sandbox run should persist a max lifetime deadline");
    assert.ok(sandboxRun?.idleExpiresAt, "live sandbox run should persist an idle deadline");
    assert.equal(Date.parse(sandboxRun.expiresAt) - Date.parse(sandboxRun.createdAt), 2 * 60 * 60 * 1000);
    assert.equal(Date.parse(sandboxRun.idleExpiresAt) - Date.parse(sandboxRun.createdAt), 30 * 60 * 1000);
    assert.equal(JSON.stringify(sandboxRun).includes("test-service-key"), false);
    assert.equal(JSON.stringify(sandboxRun).includes("sk-real-model-key"), false);
  });

  it("extends only the live sandbox idle deadline when active timeline events are synced", async () => {
    const botified = new FakeBotifiedClient([
      { status: "ok", events: [], nextCursor: "c0" },
      {
        status: "ok",
        events: [
          { cursor: "c1", seq: 1, session_id: "s1", type: "assistant_message.completed", payload: { text: "still working" } }
        ],
        nextCursor: "c1"
      }
    ]);
    const livePort = new FakeLiveSandboxPort({ readiness: ["ready"] });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1/"
      }),
      liveSandbox: {
        port: livePort,
        sleep: livePort.sleep
      }
    });
    const task = await services.tasks.createTask(userId, projectId, { prompt: "keep alive", endpointId });
    const initialRun = await store.sandboxRuns.get(task.runId);
    assert.ok(initialRun?.expiresAt);
    assert.ok(initialRun.idleExpiresAt);
    const shortenedIdleDeadline = new Date(Date.parse(initialRun.idleExpiresAt) - 60_000).toISOString();
    const shortenedRun = await store.sandboxRuns.updateWithFencing(task.runId, initialRun.fencingToken, {
      ...initialRun,
      idleExpiresAt: shortenedIdleDeadline,
      fencingToken: initialRun.fencingToken + 1
    });
    assert.ok(shortenedRun);

    const events = await services.tasks.listTaskEvents(userId, task.id);

    const refreshedRun = await store.sandboxRuns.get(task.runId);
    assert.deepEqual(events.map((event) => event.kind), ["assistant_message"]);
    assert.equal(refreshedRun?.expiresAt, initialRun.expiresAt);
    assert.ok(refreshedRun?.idleExpiresAt);
    assert.ok(Date.parse(refreshedRun.idleExpiresAt) > Date.parse(shortenedIdleDeadline));
    assert.equal(JSON.stringify(refreshedRun).includes("test-service-key"), false);
    assert.equal(JSON.stringify(refreshedRun).includes("sk-real-model-key"), false);
  });

  it("honors configured live sandbox max lifetime and idle timeout durations", async () => {
    const botified = new FakeBotifiedClient([{ status: "ok", events: [], nextCursor: "c0" }]);
    const livePort = new FakeLiveSandboxPort({ readiness: ["ready"] });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1/"
      }),
      liveSandbox: {
        port: livePort,
        sleep: livePort.sleep
      },
      liveSandboxMaxLifetimeMs: 90_000,
      liveSandboxIdleTimeoutMs: 15_000
    });

    const task = await services.tasks.createTask(userId, projectId, { prompt: "custom ttl", endpointId });

    const sandboxRun = await store.sandboxRuns.get(task.runId);
    assert.ok(sandboxRun?.expiresAt);
    assert.ok(sandboxRun.idleExpiresAt);
    assert.equal(Date.parse(sandboxRun.expiresAt) - Date.parse(sandboxRun.createdAt), 90_000);
    assert.equal(Date.parse(sandboxRun.idleExpiresAt) - Date.parse(sandboxRun.createdAt), 15_000);
  });

  it("rejects live startup on endpoint credential baseUrl mismatch before creating a task", async () => {
    const operations: string[] = [];
    const botified = new FakeBotifiedClient([], { operations });
    const livePort = new FakeLiveSandboxPort({ operations, readiness: ["ready"] });
    const resolver = new FakeCredentialResolver({
      apiKey: "sk-real-model-key",
      baseUrl: "https://other.example.com/v1"
    });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
      modelCredentialResolver: resolver,
      liveSandbox: {
        port: livePort,
        sleep: livePort.sleep
      }
    });

    await assert.rejects(
      () => services.tasks.createTask(userId, projectId, { prompt: "no bind", endpointId }),
      /Endpoint baseUrl does not match/
    );

    assert.deepEqual(await store.listTasksForProject(projectId), []);
    assert.deepEqual(livePort.appliedResources, []);
    assert.deepEqual(botified.postMessageCalls, []);
  });

  it("polls live readiness and posts only after the pod becomes ready", async () => {
    const operations: string[] = [];
    const botified = new FakeBotifiedClient([], { operations });
    const livePort = new FakeLiveSandboxPort({ operations, readiness: ["pending", "ready"] });
    const { services, userId, projectId, endpointId } = await setupTaskServices(botified, {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1"
      }),
      liveSandbox: {
        port: livePort,
        readinessTimeoutMs: 100,
        readinessPollMs: 25,
        sleep: livePort.sleep
      }
    });

    await services.tasks.createTask(userId, projectId, { prompt: "wait for me", endpointId });

    assert.deepEqual(livePort.sleeps, [25]);
    assert.deepEqual(operations.filter((operation) => operation.startsWith("readiness:")).length, 2);
    assert.ok(operations.lastIndexOf("readiness:asl-task-" + livePort.taskId) < operations.indexOf("post"));
  });

  it("marks the task failed and best-effort cleans up when readiness fails or times out", async () => {
    for (const readiness of ["failed", "fence_mismatch"] as const) {
      const botified = new FakeBotifiedClient([]);
      const livePort = new FakeLiveSandboxPort({ readiness: [readiness] });
      const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
        modelCredentialResolver: new FakeCredentialResolver({
          apiKey: "sk-real-model-key",
          baseUrl: "https://models.example.com/v1"
        }),
        liveSandbox: {
          port: livePort,
          readinessTimeoutMs: 100,
          readinessPollMs: 10,
          sleep: livePort.sleep
        }
      });

      await assert.rejects(() => services.tasks.createTask(userId, projectId, { prompt: readiness, endpointId }));

      const [task] = await store.listTasksForProject(projectId);
      assert.equal(task?.status, "failed");
      assert.equal(botified.postMessageCalls.length, 0);
      assert.deepEqual(livePort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
      assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleaned");
    }

    const botified = new FakeBotifiedClient([]);
    const timeoutPort = new FakeLiveSandboxPort({ readiness: ["pending", "pending", "pending"] });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1"
      }),
      liveSandbox: {
        port: timeoutPort,
        readinessTimeoutMs: 15,
        readinessPollMs: 10,
        sleep: timeoutPort.sleep
      }
    });

    await assert.rejects(
      () => services.tasks.createTask(userId, projectId, { prompt: "timeout", endpointId }),
      /Timed out waiting for sandbox pod readiness/
    );
    const [task] = await store.listTasksForProject(projectId);
    assert.equal(task?.status, "failed");
    assert.equal(botified.postMessageCalls.length, 0);
    assert.deepEqual(timeoutPort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleaned");
  });

  it("still cleans up and rethrows the original startup error when failed-state update fails", async () => {
    const startupError = new Error("k8s exploded");
    const livePort = new FakeLiveSandboxPort({ applyResults: [startupError] });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(new FakeBotifiedClient([]), {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1"
      }),
      liveSandbox: {
        port: livePort,
        sleep: livePort.sleep
      }
    });
    const updateTask = store.updateTask.bind(store);
    let failedUpdateAttempts = 0;
    store.updateTask = async (task) => {
      if (task.status === "failed") {
        failedUpdateAttempts += 1;
        throw new Error("store failed-state update failed");
      }
      return updateTask(task);
    };

    await assert.rejects(
      () => services.tasks.createTask(userId, projectId, { prompt: "apply throws", endpointId }),
      /k8s exploded/
    );

    assert.equal(failedUpdateAttempts, 1);
    assert.deepEqual(livePort.deletedRefs.map((ref) => ref.kind), []);
    const [task] = await store.listTasksForProject(projectId);
    assert.ok(task);
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleaned");
  });

  it("marks failed and cleans up on live apply or post failures while rethrowing the original error", async () => {
    const applyPort = new FakeLiveSandboxPort({ applyResults: ["fence_mismatch"] });
    const applyFailure = await setupTaskServices(new FakeBotifiedClient([]), {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1"
      }),
      liveSandbox: {
        port: applyPort,
        sleep: applyPort.sleep
      }
    });

    await assert.rejects(
      () => applyFailure.services.tasks.createTask(applyFailure.userId, applyFailure.projectId, {
        prompt: "apply fail",
        endpointId: applyFailure.endpointId
      }),
      /Kubernetes apply fence mismatch/
    );
    assert.equal((await applyFailure.store.listTasksForProject(applyFailure.projectId))[0]?.status, "failed");
    assert.deepEqual(applyPort.deletedRefs.map((ref) => ref.kind), []);

    const postNotAcceptedPort = new FakeLiveSandboxPort({ readiness: ["ready"] });
    const postNotAcceptedBotified = new FakeBotifiedClient([], { postResult: { accepted: false } });
    const postNotAccepted = await setupTaskServices(postNotAcceptedBotified, {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1"
      }),
      liveSandbox: {
        port: postNotAcceptedPort,
        sleep: postNotAcceptedPort.sleep
      }
    });
    await assert.rejects(
      () => postNotAccepted.services.tasks.createTask(postNotAccepted.userId, postNotAccepted.projectId, {
        prompt: "post false",
        endpointId: postNotAccepted.endpointId
      }),
      /Botified did not accept task prompt/
    );
    assert.equal((await postNotAccepted.store.listTasksForProject(postNotAccepted.projectId))[0]?.status, "failed");
    assert.deepEqual(postNotAcceptedPort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);

    const postErrorPort = new FakeLiveSandboxPort({ readiness: ["ready"] });
    const postErrorBotified = new FakeBotifiedClient([], { postError: new Error("runtime down") });
    const postError = await setupTaskServices(postErrorBotified, {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1"
      }),
      liveSandbox: {
        port: postErrorPort,
        sleep: postErrorPort.sleep
      }
    });
    await assert.rejects(
      () => postError.services.tasks.createTask(postError.userId, postError.projectId, {
        prompt: "post throws",
        endpointId: postError.endpointId
      }),
      /Botified send message failed: runtime down/
    );
    assert.equal((await postError.store.listTasksForProject(postError.projectId))[0]?.status, "failed");
    assert.deepEqual(postErrorPort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
  });

  it("aborts live Botified tasks before marking stopping and then reaps the run", async () => {
    const botified = new FakeBotifiedClient([{ status: "ok", events: [], nextCursor: "c0" }]);
    const livePort = new FakeLiveSandboxPort({ readiness: ["ready"] });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1"
      }),
      liveSandbox: {
        port: livePort,
        sleep: livePort.sleep
      }
    });
    const task = await services.tasks.createTask(userId, projectId, { prompt: "stop live", endpointId });

    const cancelled = await services.tasks.cancelTask(userId, task.id);

    assert.equal(cancelled.status, "stopping");
    assert.deepEqual(botified.abortCalls.map((call) => call.baseUrl), [
      `http://asl-task-${task.id}.agentsmith.svc.cluster.local:3099`
    ]);
    assert.deepEqual(livePort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleaned");
  });

  it("does not delete live resources when Botified abort fails", async () => {
    const botified = new FakeBotifiedClient([{ status: "ok", events: [], nextCursor: "c0" }], {
      abortError: new Error("abort failed")
    });
    const livePort = new FakeLiveSandboxPort({ readiness: ["ready"] });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1"
      }),
      liveSandbox: {
        port: livePort,
        sleep: livePort.sleep
      }
    });
    const task = await services.tasks.createTask(userId, projectId, { prompt: "abort fail", endpointId });

    await assert.rejects(() => services.tasks.cancelTask(userId, task.id), /Botified abort failed: abort failed/);

    assert.deepEqual(livePort.deletedRefs, []);
    assert.equal((await store.sandboxRuns.get(task.runId))?.phase, "running");
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "active");
  });

  it("requests live cleanup when terminal timeline events are projected", async () => {
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          { cursor: "c1", seq: 1, session_id: "s1", type: "cycle.completed", payload: { ok: true } }
        ],
        nextCursor: "c1"
      }
    ]);
    const livePort = new FakeLiveSandboxPort({ readiness: ["ready"] });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1"
      }),
      liveSandbox: {
        port: livePort,
        sleep: livePort.sleep
      }
    });

    const task = await services.tasks.createTask(userId, projectId, { prompt: "finish", endpointId });

    assert.equal(task.status, "completed");
    assert.deepEqual(livePort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleaned");
  });

  it("retries terminal live cleanup when the first run-state write loses its fence", async () => {
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          { cursor: "c1", seq: 1, session_id: "s1", type: "cycle.completed", payload: { ok: true } }
        ],
        nextCursor: "c1"
      }
    ]);
    const livePort = new FakeLiveSandboxPort({ readiness: ["ready"] });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1"
      }),
      liveSandbox: {
        port: livePort,
        sleep: livePort.sleep
      }
    });
    const updateRunWithFencing = store.sandboxRuns.updateWithFencing.bind(store.sandboxRuns);
    let failedCleanupWrites = 0;
    store.sandboxRuns.updateWithFencing = async (runId, expectedFencingToken, run) => {
      if (run.cleanupStatus === "cleanup_requested" && failedCleanupWrites === 0) {
        failedCleanupWrites += 1;
        return null;
      }
      return updateRunWithFencing(runId, expectedFencingToken, run);
    };

    const task = await services.tasks.createTask(userId, projectId, { prompt: "finish then retry", endpointId });

    assert.equal(task.status, "completed");
    assert.equal(failedCleanupWrites, 1);
    assert.equal(livePort.deletedRefs.length, 0);
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "active");

    const events = await services.tasks.listTaskEvents(userId, task.id);

    assert.deepEqual(events.map((event) => event.kind), ["turn_completed"]);
    assert.deepEqual(livePort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleaned");
  });

  it("redacts secret-like Botified error text before surfacing task errors", async () => {
    const botified = new FakeBotifiedClient([], {
      postError: new BotifiedHttpError({
        status: 503,
        code: "runner_unavailable",
        message: "runner leaked Bearer bsk_runtime_secret and bsk_another_secret and sk-real-model-key",
        retryable: true,
        responseBody: { error: { code: "runner_unavailable" } },
        timelineCursor: "cursor-bsk_runtime_secret",
        historyBoundary: "boundary sk-real-model-key"
      })
    });
    const { services, userId, projectId, endpointId } = await setupTaskServices(botified, {
      serviceKeyFactory: () => "bsk_runtime_secret"
    });

    await assert.rejects(
      () => services.tasks.createTask(userId, projectId, { prompt: "redact", endpointId }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Bearer <redacted>/);
        assert.match(error.message, /bsk_<redacted>/);
        assert.match(error.message, /sk-<redacted>/);
        assert.deepEqual((error as { details?: Record<string, unknown> }).details, {
          timelineCursor: "cursor-bsk_<redacted>",
          historyBoundary: "boundary sk-<redacted>"
        });
        assert.doesNotMatch(JSON.stringify(error), /bsk_runtime_secret|bsk_another_secret|sk-real-model-key/);
        return true;
      }
    );
  });

  it("syncs timeline events idempotently while returning stored task artifacts", async () => {
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          { cursor: "c1", seq: 1, session_id: "s1", type: "input.accepted", payload: { text: "ship" } },
          { cursor: "c2", seq: 2, session_id: "s1", type: "assistant_message.completed", payload: { text: "ok" } }
        ],
        nextCursor: "c2"
      },
      {
        status: "ok",
        events: [
          { cursor: "c1", seq: 1, session_id: "s1", type: "input.accepted", payload: { text: "duplicate" } },
          { cursor: "c2", seq: 2, session_id: "s1", type: "assistant_message.completed", payload: { text: "duplicate" } },
          { cursor: "c3", seq: 3, session_id: "s1", type: "file.published", payload: { file_id: "f2", name: "notes.md", bytes: 9 } }
        ],
        nextCursor: "c3"
      },
      {
        status: "ok",
        events: [
          { cursor: "c3", seq: 3, session_id: "s1", type: "file.published", payload: { file_id: "f2", name: "again.md", bytes: 99 } }
        ],
        nextCursor: "c3"
      }
    ]);
    const { services, userId, projectId, endpointId } = await setupTaskServices(botified);
    const task = await services.tasks.createTask(userId, projectId, { prompt: "ship", endpointId });

    const events = await services.tasks.listTaskEvents(userId, task.id);
    const artifacts = await services.tasks.listTaskArtifacts(userId, task.id);
    const eventsAgain = await services.tasks.listTaskEvents(userId, task.id);

    assert.deepEqual(events.map((event) => event.botifiedSeq), [1, 2, 3]);
    assert.deepEqual(eventsAgain.map((event) => event.botifiedSeq), [1, 2, 3]);
    assert.deepEqual(artifacts.map((artifact) => [artifact.fileId, artifact.name, artifact.bytes]), [["f2", "notes.md", 9]]);
    assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), [undefined, "c2", "c3", "c3"]);
  });

  it("downloads newly published Botified artifacts into the product artifact directory idempotently", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-artifacts-"));
    const artifactBytes = new TextEncoder().encode("hello from published artifact");
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          {
            cursor: "c1",
            seq: 1,
            session_id: "s1",
            type: "file.published",
            payload: {
              file_id: "file_real_1",
              filename: "../final report.txt",
              mime_type: "text/plain",
              size_bytes: artifactBytes.byteLength,
              sha256: "a".repeat(64),
              download_url: "http://botified.internal/v1/files/file_real_1?service_key=bsk_runtime_secret"
            }
          }
        ],
        nextCursor: "c1"
      },
      {
        status: "ok",
        events: [
          {
            cursor: "c1",
            seq: 1,
            session_id: "s1",
            type: "file.published",
            payload: {
              file_id: "file_real_1",
              filename: "../../overwrite.txt",
              size_bytes: 999,
              download_url: "http://botified.internal/v1/files/file_real_1"
            }
          }
        ],
        nextCursor: "c1"
      }
    ], {
      downloads: {
        file_real_1: artifactBytes
      }
    });

    try {
      const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, { dataRoot });
      const task = await services.tasks.createTask(userId, projectId, { prompt: "publish", endpointId });

      const artifacts = await services.tasks.listTaskArtifacts(userId, task.id);
      const events = await services.tasks.listTaskEvents(userId, task.id);
      const artifact = artifacts[0];
      assert.ok(artifact, "expected a projected artifact");
      const project = await store.findProject(projectId);
      assert.ok(project, "expected project fixture");
      const artifactPath = path.join(dataRoot, project.rootPath, "tasks", task.id, "artifacts", `${artifact.id}-final-report.txt`);

      assert.deepEqual(artifacts.map((item) => [item.fileId, item.name, item.bytes, item.sha256]), [
        ["file_real_1", "final-report.txt", artifactBytes.byteLength, "a".repeat(64)]
      ]);
      assert.equal(await readFile(artifactPath, "utf8"), "hello from published artifact");
      assert.deepEqual(botified.downloadFileCalls, [
        {
          baseUrl: `http://asl-task-${task.id}.agentsmith.svc.cluster.local:3099`,
          serviceKey: "test-service-key",
          fileId: "file_real_1"
        }
      ]);
      assert.equal(JSON.stringify({ events, artifacts }).includes("download_url"), false);
      assert.doesNotMatch(JSON.stringify({ events, artifacts }), /botified\.internal|bsk_runtime_secret|\/v1\/files/);

      await services.tasks.listTaskArtifacts(userId, task.id);
      assert.equal(botified.downloadFileCalls.length, 1);
      assert.equal(await readFile(artifactPath, "utf8"), "hello from published artifact");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("best-effort syncs task artifacts even when the ProductStore already has one", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-artifacts-refresh-"));
    const firstBytes = new TextEncoder().encode("first persisted artifact");
    const secondBytes = new TextEncoder().encode("second later artifact");
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          {
            cursor: "c1",
            seq: 1,
            session_id: "s1",
            type: "file.published",
            payload: {
              file_id: "refresh_file_1",
              filename: "first.txt",
              size_bytes: firstBytes.byteLength
            }
          }
        ],
        nextCursor: "c1"
      },
      {
        status: "ok",
        events: [
          {
            cursor: "c2",
            seq: 2,
            session_id: "s1",
            type: "file.published",
            payload: {
              file_id: "refresh_file_2",
              filename: "second.txt",
              size_bytes: secondBytes.byteLength
            }
          }
        ],
        nextCursor: "c2"
      }
    ], {
      downloads: {
        refresh_file_1: firstBytes,
        refresh_file_2: secondBytes
      }
    });

    try {
      const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, { dataRoot });
      const task = await services.tasks.createTask(userId, projectId, { prompt: "publish twice", endpointId });
      const persisted = await store.listTaskArtifacts(task.id);
      assert.deepEqual(persisted.map((artifact) => [artifact.fileId, artifact.name, artifact.bytes]), [
        ["refresh_file_1", "first.txt", firstBytes.byteLength]
      ]);

      const artifacts = await services.tasks.listTaskArtifacts(userId, task.id);

      assert.deepEqual(artifacts.map((artifact) => [artifact.fileId, artifact.name, artifact.bytes]), [
        ["refresh_file_1", "first.txt", firstBytes.byteLength],
        ["refresh_file_2", "second.txt", secondBytes.byteLength]
      ]);
      assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), [undefined, "c1"]);
      assert.deepEqual(botified.downloadFileCalls.map((call) => call.fileId), ["refresh_file_1", "refresh_file_2"]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("serves persisted task artifacts when the Botified runtime is unavailable", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-artifacts-offline-"));
    const artifactBytes = new TextEncoder().encode("persisted artifact survives runtime cleanup");
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          {
            cursor: "c1",
            seq: 1,
            session_id: "s1",
            type: "file.published",
            payload: {
              file_id: "offline_file_1",
              filename: "offline.txt",
              size_bytes: artifactBytes.byteLength,
              download_url: "http://botified.internal/v1/files/offline_file_1?service_key=bsk_runtime_secret"
            }
          }
        ],
        nextCursor: "c1"
      }
    ], {
      downloads: {
        offline_file_1: artifactBytes
      }
    });

    try {
      const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, { dataRoot });
      const task = await services.tasks.createTask(userId, projectId, { prompt: "publish then disappear", endpointId });
      const persisted = (await store.listTaskArtifacts(task.id))[0];
      assert.ok(persisted, "expected the initial sync to persist an artifact");
      botified.readTimelineError = new BotifiedHttpError({
        status: 401,
        code: "invalid_service_key",
        message: "invalid service key bsk_runtime_secret",
        retryable: false,
        responseBody: { error: { code: "invalid_service_key" } }
      });

      const artifacts = await services.tasks.listTaskArtifacts(userId, task.id);
      const downloaded = await services.tasks.downloadTaskArtifact(userId, task.id, persisted.id);

      assert.deepEqual(artifacts.map((artifact) => [artifact.id, artifact.fileId, artifact.name, artifact.bytes]), [
        [persisted.id, "offline_file_1", "offline.txt", artifactBytes.byteLength]
      ]);
      assert.equal(downloaded.artifact.id, persisted.id);
      assert.equal(downloaded.bytes.toString("utf8"), "persisted artifact survives runtime cleanup");
      assert.doesNotMatch(JSON.stringify({ artifacts, downloaded: downloaded.artifact }), /botified\.internal|bsk_runtime_secret|download_url/);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("retries artifact persistence when the first Botified download fails", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-artifacts-retry-"));
    const artifactBytes = new TextEncoder().encode("retry fills product artifact");
    const published = {
      cursor: "c1",
      seq: 1,
      session_id: "s1",
      type: "file.published",
      payload: {
        file_id: "retry_file_1",
        filename: "retry.txt",
        size_bytes: artifactBytes.byteLength
      }
    };
    const botified = new FakeBotifiedClient([
      { status: "ok", events: [published], nextCursor: "c1" },
      { status: "ok", events: [published], nextCursor: "c1" }
    ], {
      downloads: {
        retry_file_1: artifactBytes
      },
      downloadFailures: {
        retry_file_1: [new Error("artifact download temporarily unavailable")]
      }
    });

    try {
      const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, { dataRoot });
      await assert.rejects(
        () => services.tasks.createTask(userId, projectId, { prompt: "publish with flaky download", endpointId }),
        /Botified download file failed: artifact download temporarily unavailable/
      );
      const [task] = await store.listTasksForProject(projectId);
      assert.ok(task, "task should remain available for a retry sync");
      assert.deepEqual(await store.listTaskArtifacts(task.id), []);

      await services.tasks.listTaskEvents(userId, task.id);
      const artifacts = await services.tasks.listTaskArtifacts(userId, task.id);
      const downloaded = await services.tasks.downloadTaskArtifact(userId, task.id, artifacts[0]?.id ?? "");

      assert.deepEqual((await store.listTaskEvents(task.id)).map((event) => event.botifiedSeq), [1]);
      assert.deepEqual(artifacts.map((artifact) => [artifact.fileId, artifact.name, artifact.bytes]), [
        ["retry_file_1", "retry.txt", artifactBytes.byteLength]
      ]);
      assert.equal(downloaded.bytes.toString("utf8"), "retry fills product artifact");
      assert.deepEqual(botified.downloadFileCalls.map((call) => call.fileId), ["retry_file_1", "retry_file_1"]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("aborts Botified before marking a task as stopping", async () => {
    const botified = new FakeBotifiedClient([{ status: "ok", events: [], nextCursor: "c0" }]);
    const { services, userId, projectId, endpointId } = await setupTaskServices(botified);
    const task = await services.tasks.createTask(userId, projectId, { prompt: "stop me", endpointId });

    const cancelled = await services.tasks.cancelTask(userId, task.id);

    assert.equal(cancelled.status, "stopping");
    assert.deepEqual(botified.abortCalls, [
      {
        baseUrl: `http://asl-task-${task.id}.agentsmith.svc.cluster.local:3099`,
        serviceKey: "test-service-key"
      }
    ]);
  });
});

interface SetupOptions {
  serviceKeyFactory?: () => string | undefined;
  dataRoot?: string;
  modelCredentialResolver?: ModelCredentialResolver;
  liveSandbox?: CreateApplicationServicesInput["liveSandbox"];
  liveSandboxMaxLifetimeMs?: number;
  liveSandboxIdleTimeoutMs?: number;
}

async function setupTaskServices(botified: FakeBotifiedClient, optionsOrFactory: SetupOptions | (() => string | undefined) = {}) {
  const options: SetupOptions = typeof optionsOrFactory === "function" ? { serviceKeyFactory: optionsOrFactory } : optionsOrFactory;
  const store = createInMemoryProductStore();
  const services = createApplicationServices({
    store,
    dataRoot: options.dataRoot ?? path.join(tmpdir(), "agentsmith-lite-task-service"),
    builtinAdminPassword: "admin-password",
    sessionSecret: "test-session-secret",
    botifiedClient: botified,
    botifiedServiceKeyFactory: options.serviceKeyFactory ?? (() => "test-service-key"),
    ...(options.modelCredentialResolver ? { modelCredentialResolver: options.modelCredentialResolver } : {}),
    ...(options.liveSandboxMaxLifetimeMs !== undefined ? { liveSandboxMaxLifetimeMs: options.liveSandboxMaxLifetimeMs } : {}),
    ...(options.liveSandboxIdleTimeoutMs !== undefined ? { liveSandboxIdleTimeoutMs: options.liveSandboxIdleTimeoutMs } : {}),
    ...(options.liveSandbox ? { liveSandbox: options.liveSandbox } : {})
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
  readonly downloadFileCalls: Array<{ baseUrl: string; serviceKey: string; fileId: string }> = [];
  readonly abortCalls: Array<{ baseUrl: string; serviceKey: string }> = [];
  readTimelineError: Error | null = null;

  constructor(
    private readonly timelineReads: BotifiedTimelineReadResult[],
    private readonly options: {
      operations?: string[];
      postResult?: BotifiedPostMessageResult;
      postError?: Error;
      abortError?: Error;
      downloads?: Record<string, Uint8Array>;
      downloadFailures?: Record<string, Error[]>;
    } = {}
  ) {}

  async health(): Promise<{ status: "ok" }> {
    return { status: "ok" };
  }

  async postMessage(baseUrl: string, serviceKey: string, message: string): Promise<BotifiedPostMessageResult> {
    this.options.operations?.push("post");
    this.postMessageCalls.push({ baseUrl, serviceKey, message });
    if (this.options.postError) {
      throw this.options.postError;
    }
    return this.options.postResult ?? { accepted: true, messageId: "msg_1", cursor: "post-cursor" };
  }

  async readTimeline(baseUrl: string, serviceKey: string, cursor?: string): Promise<BotifiedTimelineReadResult> {
    this.readTimelineCalls.push({ baseUrl, serviceKey, cursor });
    if (this.readTimelineError) {
      throw this.readTimelineError;
    }
    const next = this.timelineReads.shift();
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

  async downloadFile(baseUrl: string, serviceKey: string, fileId: string) {
    this.downloadFileCalls.push({ baseUrl, serviceKey, fileId });
    const failure = this.options.downloadFailures?.[fileId]?.shift();
    if (failure) {
      throw failure;
    }
    const bytes = this.options.downloads?.[fileId] ?? new Uint8Array();
    return {
      bytes,
      filename: `${fileId}.txt`,
      mimeType: "text/plain",
      sizeBytes: bytes.byteLength
    };
  }

  async abort(baseUrl: string, serviceKey: string): Promise<BotifiedAbortResult> {
    this.abortCalls.push({ baseUrl, serviceKey });
    if (this.options.abortError) {
      throw this.options.abortError;
    }
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
  readonly sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
  };
  taskId = "";

  private readonly operations: string[] | undefined;
  private readonly readiness: PodReadiness[];
  private readonly applyResults: Array<"applied" | "fence_mismatch" | Error>;
  private resources: KubernetesResource[] = [];

  constructor(input: {
    operations?: string[];
    readiness?: PodReadiness[];
    applyResults?: Array<"applied" | "fence_mismatch" | Error>;
  } = {}) {
    this.operations = input.operations;
    this.readiness = [...(input.readiness ?? ["ready"])];
    this.applyResults = [...(input.applyResults ?? [])];
  }

  async listManagedResources(): Promise<KubernetesResource[]> {
    return this.resources.map((resource) => structuredClone(resource));
  }

  async applyResource(resource: KubernetesResource, expectedLabels: Record<string, string>): Promise<"applied" | "fence_mismatch"> {
    this.operations?.push(`apply:${resource.kind}`);
    const result = this.applyResults.shift();
    if (result instanceof Error) {
      throw result;
    }
    if (result === "fence_mismatch" || !hasLabels(resource, expectedLabels)) {
      return "fence_mismatch";
    }
    this.appliedResources.push(structuredClone(resource));
    this.resources = this.resources.filter((candidate) => !sameRef(candidate, resourceRef(resource)));
    this.resources.push(structuredClone(resource));
    if (resource.kind === "Pod") {
      this.taskId = resource.metadata.labels["agentsmith-lite/task-id"] ?? "";
    }
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
    this.operations?.push(`delete:${ref.kind}`);
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

  async getPodReadiness(_namespace: string, name: string): Promise<PodReadiness> {
    this.operations?.push(`readiness:${name}`);
    const result = this.readiness.shift();
    return result ?? "pending";
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

interface SecretResource extends KubernetesResource {
  stringData: Record<string, string>;
}

interface ConfigMapResource extends KubernetesResource {
  data: Record<string, string>;
}
