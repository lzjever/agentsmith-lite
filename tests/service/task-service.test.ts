import assert from "node:assert/strict";
import { access, readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices, type CreateApplicationServicesInput } from "../../packages/application/src/factory.js";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import type { ModelCredential, ModelCredentialResolver } from "../../packages/openai-compatible-client/src/index.js";
import {
  BotifiedHttpError,
  type BotifiedAbortResult,
  type BotifiedPostMessageResult,
  type BotifiedRuntimeStateResult,
  type BotifiedRuntimeHttpClient,
  type BotifiedTimelineReadResult,
  type BotifiedUploadFileInput,
  type BotifiedUploadFileResult
} from "../../packages/ports/src/botified.js";
import type { PersistedSandboxRunState } from "../../packages/ports/src/store.js";
import type {
  KubernetesResourceRef,
  PodReadiness,
  SandboxKubernetesMutationPort,
  SandboxKubernetesReadinessPort
} from "../../packages/sandbox-controller/src/kubernetesPort.js";
import { sandboxResourceNamesForTask, sandboxServiceNameForTask } from "../../packages/sandbox-controller/src/resourceNames.js";

describe("task service Botified orchestration", () => {
  it("sends the prompt through Botified, stores projected events, and keeps service keys server-side", async () => {
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
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
          { cursor: "c3", seq: 3, session_id: "s1", type: "file.published", payload: { file_id: "f1", name: "artifact.txt", bytes: 12 } }
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
        baseUrl: botifiedBaseUrlForTask(task.id),
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
    assert.equal(task.prompt, "build it");
    assert.deepEqual(events.map((event) => event.kind), ["assistant_message", "artifact"]);
    assert.deepEqual(events.map((event) => event.botifiedSeq), [2, 3]);
    assert.equal(events[0]?.payload.text, "working with Bearer <redacted> and sk-<redacted>");
    assert.deepEqual(events[0]?.payload.notes, ["safe", "array bsk_<redacted>", { nested: "sk-<redacted>" }]);
    assert.deepEqual(events[0]?.payload.nested, { apiKey: "[redacted]", trace: "Bearer <redacted>" });
    assert.doesNotMatch(
      JSON.stringify(events),
      /bsk_timeline_secret|sk-timeline-secret|bsk_array_secret|sk-nested-secret|sk-field-secret|bsk_nested_secret/
    );
    const artifacts = await store.listTaskArtifacts(task.id);
    assert.deepEqual(artifacts.map((artifact) => [artifact.taskId, artifact.fileId, artifact.name, artifact.bytes]), [
      [task.id, "f1", "artifact.txt", 12]
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

  it("rejects endpoints missing task capabilities before creating sandbox or Botified side effects", async () => {
    for (const { capabilities, missingCapability } of [
      { capabilities: ["text"] as const, missingCapability: "tool_calls" },
      { capabilities: ["tool_calls"] as const, missingCapability: "text" }
    ]) {
      const operations: string[] = [];
      const botified = new FakeBotifiedClient([], { operations });
      const livePort = new FakeLiveSandboxPort({ operations, readiness: ["ready"] });
      const resolver = new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1/"
      });
      const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
        endpointCapabilities: [...capabilities],
        modelCredentialResolver: resolver,
        liveSandbox: {
          port: livePort,
          readinessTimeoutMs: 1000,
          readinessPollMs: 10,
          sleep: livePort.sleep
        }
      });

      await assert.rejects(
        () => services.tasks.createTask(userId, projectId, { prompt: "publish a file", endpointId }),
        (error: unknown) => {
          assert.ok(error instanceof ProductError);
          assert.equal(error.statusCode, 409);
          assert.match(error.message, new RegExp(missingCapability));
          assert.doesNotMatch(error.message, /sk-real-model-key|secret\/openai/);
          return true;
        }
      );
      assert.deepEqual(operations, []);
      assert.equal(livePort.appliedResources.length, 0);
      assert.equal(botified.postMessageCalls.length, 0);
      assert.deepEqual(resolver.calls, []);
      assert.deepEqual(await store.listTasksForProject(projectId), []);
    }
  });

  it("does not resolve or use a pre-existing credential-bound endpoint for a non-admin live task owner", async () => {
    const operations: string[] = [];
    const botified = new FakeBotifiedClient([], { operations });
    const livePort = new FakeLiveSandboxPort({ operations, readiness: ["ready"] });
    const resolver = new FakeCredentialResolver({
      apiKey: "sk-real-model-key",
      baseUrl: "https://models.example.com/v1"
    });
    const { services, store } = await setupTaskServices(botified, {
      modelCredentialResolver: resolver,
      liveSandbox: {
        port: livePort,
        readinessTimeoutMs: 1000,
        readinessPollMs: 10,
        sleep: livePort.sleep
      }
    });
    const member = await services.auth.loginExternalPrincipal({
      issuer: "https://keycloak.example.test/realms/agentsmith",
      subject: "member-task-owner",
      email: "member@example.test"
    });
    const workspace = await services.workspaces.createWorkspace(member.user.id, { name: "Member workspace" });
    const project = await services.workspaces.createProject(member.user.id, workspace.id, { name: "Member project" });
    const endpoint = await store.createEndpoint({
      id: "endp_preexisting_member",
      projectId: project.id,
      name: "openai-compatible",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.com/v1",
      model: "gpt-compatible",
      apiKeySecretRef: "secret/openai",
      capabilities: ["text", "tool_calls"],
      requestTimeoutSecs: 45,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    await assert.rejects(
      () => services.tasks.createTask(member.user.id, project.id, { prompt: "publish a file", endpointId: endpoint.id }),
      (error: unknown) => error instanceof ProductError && error.statusCode === 403
    );
    assert.deepEqual(resolver.calls, []);
    assert.deepEqual(operations, []);
    assert.equal(botified.postMessageCalls.length, 0);
    assert.deepEqual(await store.listTasksForProject(project.id), []);
  });

  it("uses the safe Botified post cursor as the first timeline resume cursor", async () => {
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: []
      }
    ], {
      postResult: {
        accepted: true,
        messageId: "msg_1",
        cursor: "timeline:main:post"
      }
    });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified);

    const task = await services.tasks.createTask(userId, projectId, {
      prompt: "start from the post cursor",
      endpointId
    });

    const runtimeState = await store.jsonDocs.get("sandbox_runtime_state", task.id);
    assert.ok(runtimeState, "runtime state should be stored");
    assert.equal(runtimeState.timelineCursor, "timeline:main:post");
    assert.equal("postMessageCursor" in runtimeState, false);
    assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), ["timeline:main:post"]);
  });

  it("keeps dry-run default local and does not resolve model credentials or apply live resources", async () => {
    const botified = new FakeBotifiedClient([]);
    const resolver = new FakeCredentialResolver({
      apiKey: "sk-real-model-key",
      baseUrl: "https://models.example.com/v1"
    });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
      modelCredentialResolver: resolver,
      sandboxNamespaceLimit: 1
    });
    await store.sandboxRuns.put(activeSandboxRun({ namespace: "agentsmith", runId: "run-existing" }));

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
      baseUrl: "https://agentsmith-lite-local-openai.agentsmith.svc.cluster.local/v1/"
    });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
      endpointBaseUrl: "https://agentsmith-lite-local-openai.agentsmith.svc.cluster.local/v1",
      modelCredentialResolver: resolver,
      modelCa: {
        configMapName: "local-model-ca",
        configMapKey: "provider-ca.pem",
        path: "/etc/agentsmith-lite/model-ca/ca.crt"
      },
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

    const expectedResourceNames = sandboxResourceNamesForTask(task.id);
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
    assert.ok(operations.lastIndexOf("apply:Pod") < operations.indexOf(`readiness:${expectedResourceNames.pod}`));
    assert.ok(operations.indexOf(`readiness:${expectedResourceNames.pod}`) < operations.indexOf("post"));
    for (const resource of livePort.appliedResources) {
      assertDnsLabel(resource.metadata.name);
      assert.equal(resource.metadata.labels["agentsmith-lite/task-id"], task.id);
      assert.equal(resource.metadata.labels["agentsmith-lite/run-id"], task.runId);
    }
    assert.deepEqual(
      Object.fromEntries(livePort.appliedResources.map((resource) => [resource.kind, resource.metadata.name])),
      {
        Secret: expectedResourceNames.secret,
        ConfigMap: expectedResourceNames.configMap,
        ServiceAccount: expectedResourceNames.serviceAccount,
        NetworkPolicy: expectedResourceNames.networkPolicy,
        Service: expectedResourceNames.service,
        Pod: expectedResourceNames.pod
      }
    );

    const appliedSecret = livePort.appliedResources.find((resource) => resource.kind === "Secret") as SecretResource | undefined;
    assert.deepEqual(appliedSecret?.stringData, {
      BOTIFIED_SERVICE_KEY: "test-service-key",
      MODEL_API_KEY: "sk-real-model-key"
    });
    const appliedConfig = livePort.appliedResources.find((resource) => resource.kind === "ConfigMap") as ConfigMapResource | undefined;
    const appliedPod = livePort.appliedResources.find((resource) => resource.kind === "Pod") as PodResource | undefined;
    const generatedConfig = JSON.parse(appliedConfig?.data["botified-config.yaml"] ?? "{}") as {
      runtime?: { cwd?: string; data_dir?: string };
      service?: { host?: string; port?: number };
      providers?: Array<{ base_url?: string; api_key_env?: string; ca_bundle_path?: string }>;
    };
    assert.equal(generatedConfig.runtime?.cwd, "/workspace/task/home");
    assert.equal(generatedConfig.runtime?.data_dir, "/workspace/task/botified");
    assert.equal(generatedConfig.service?.host, "0.0.0.0");
    assert.equal(generatedConfig.service?.port, 3099);
    assert.equal(generatedConfig.providers?.[0]?.base_url, "https://agentsmith-lite-local-openai.agentsmith.svc.cluster.local/v1");
    assert.equal(generatedConfig.providers?.[0]?.api_key_env, "MODEL_API_KEY");
    assert.equal(generatedConfig.providers?.[0]?.ca_bundle_path, "/etc/agentsmith-lite/model-ca/ca.crt");
    assert.equal(JSON.stringify(generatedConfig).includes("sk-real-model-key"), false);
    assert.equal(JSON.stringify(generatedConfig).includes("BEGIN CERTIFICATE"), false);
    const projectMount = appliedPod?.spec.containers[0]?.volumeMounts.find(
      (mount) => mount.name === "project-files" && mount.mountPath === "/workspace/project"
    );
    const taskHomeMount = appliedPod?.spec.containers[0]?.volumeMounts.find(
      (mount) => mount.name === "project-files" && mount.mountPath === "/workspace/task/home"
    );
    const botifiedMount = appliedPod?.spec.containers[0]?.volumeMounts.find(
      (mount) => mount.name === "project-files" && mount.mountPath === "/workspace/task/botified"
    );
    const projectSubPath = projectMount?.subPath;
    assert.ok(projectSubPath);
    assert.deepEqual(projectMount, {
      name: "project-files",
      mountPath: "/workspace/project",
      subPath: projectSubPath,
      readOnly: true
    });
    assert.deepEqual(taskHomeMount, {
      name: "project-files",
      mountPath: "/workspace/task/home",
      subPath: `${projectSubPath}/tasks/${task.id}/home`
    });
    assert.deepEqual(botifiedMount, {
      name: "project-files",
      mountPath: "/workspace/task/botified",
      subPath: `${projectSubPath}/tasks/${task.id}/botified`
    });
    assert.equal(
      appliedPod?.spec.containers[0]?.volumeMounts.some((mount) => mount.subPath?.endsWith("/artifacts")),
      false
    );
    assert.equal(botified.postMessageCalls[0]?.baseUrl, botifiedBaseUrlForTask(task.id));
    assert.equal(botified.readTimelineCalls[0]?.baseUrl, botifiedBaseUrlForTask(task.id));
    const appliedContainer = appliedPod?.spec.containers[0];
    assert.ok(
      appliedContainer?.volumeMounts.some(
        (mount) => mount.name === "model-ca" && mount.mountPath === "/etc/agentsmith-lite/model-ca/ca.crt" && mount.subPath === "ca.crt" && mount.readOnly === true
      )
    );
    assert.ok(
      appliedPod?.spec.volumes.some(
        (volume) =>
          volume.name === "model-ca" &&
          volume.configMap?.name === "local-model-ca" &&
          volume.configMap.items?.[0]?.key === "provider-ca.pem" &&
          volume.configMap.items?.[0]?.path === "ca.crt"
      )
    );

    const appliedNetworkPolicy = livePort.appliedResources.find((resource) => resource.kind === "NetworkPolicy") as
      | NetworkPolicyResource
      | undefined;
    const modelEgress = appliedNetworkPolicy?.spec.egress.find(hasAgentsmithLocalOpenAiDestination);
    assert.ok(modelEgress, "live sandbox should allow the configured local OpenAI provider service pods");
    assert.deepEqual(modelEgress.ports, [
      { protocol: "TCP", port: 443 },
      { protocol: "TCP", port: 8443 }
    ]);
    assert.equal(
      appliedNetworkPolicy?.spec.egress.some((rule) => hasUnscopedDestination(rule) && hasPort(rule, "TCP", 443)),
      false
    );

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
    assert.deepEqual(sandboxRun?.resourceNames, expectedResourceNames);
    assert.equal(sandboxRun?.serviceKeySecretRef.name, expectedResourceNames.secret);
    assert.ok(sandboxRun?.expiresAt, "live sandbox run should persist a max lifetime deadline");
    assert.ok(sandboxRun?.idleExpiresAt, "live sandbox run should persist an idle deadline");
    assert.equal(Date.parse(sandboxRun.expiresAt) - Date.parse(sandboxRun.createdAt), 2 * 60 * 60 * 1000);
    assert.equal(Date.parse(sandboxRun.idleExpiresAt) - Date.parse(sandboxRun.createdAt), 30 * 60 * 1000);
    assert.equal(JSON.stringify(sandboxRun).includes("test-service-key"), false);
    assert.equal(JSON.stringify(sandboxRun).includes("sk-real-model-key"), false);
  });

  it("terminalizes and reaps a live run when cleanup wins the startup fence after readiness", async () => {
    const operations: string[] = [];
    const botified = new FakeBotifiedClient([], { operations });
    const livePort = new FakeLiveSandboxPort({ operations, readiness: ["ready"] });
    const setup = await setupTaskServices(botified, {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1"
      }),
      liveSandbox: {
        port: livePort,
        readinessTimeoutMs: 1000,
        readinessPollMs: 10,
        sleep: livePort.sleep
      }
    });
    const updateWithFencing = setup.store.sandboxRuns.updateWithFencing.bind(setup.store.sandboxRuns);
    let cleanupWon = false;
    setup.store.sandboxRuns.updateWithFencing = async (runId, token, next) => {
      if (!cleanupWon && next.phase === "running" && next.cleanupStatus === "active") {
        cleanupWon = true;
        const current = await setup.store.sandboxRuns.get(runId);
        assert.ok(current);
        await updateWithFencing(runId, current.fencingToken, {
          ...current,
          phase: "stopping",
          cleanupStatus: "cleanup_requested",
          fencingToken: current.fencingToken + 1,
          updatedAt: "2026-07-04T00:00:01.000Z"
        });
        return null;
      }
      return updateWithFencing(runId, token, next);
    };

    await assert.rejects(
      () => setup.services.tasks.createTask(setup.userId, setup.projectId, { prompt: "do not post", endpointId: setup.endpointId }),
      /fencing token changed/
    );

    const task = (await setup.store.listTasksForProject(setup.projectId))[0];
    assert.ok(task);
    assert.equal(operations.includes("post"), false);
    assert.equal(task.status, "failed");
    const run = await setup.store.sandboxRuns.get(task.runId);
    assert.equal(run?.phase, "cleaned");
    assert.equal(run?.cleanupStatus, "cleaned");
    assert.deepEqual(livePort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
  });

  it("terminalizes and reaps a live run when its deadline expires before the startup claim", async () => {
    const operations: string[] = [];
    const botified = new FakeBotifiedClient([], { operations });
    const livePort = new FakeLiveSandboxPort({ operations, readiness: ["ready"] });
    const setup = await setupTaskServices(botified, {
      modelCredentialResolver: new FakeCredentialResolver({
        apiKey: "sk-real-model-key",
        baseUrl: "https://models.example.com/v1"
      }),
      liveSandbox: {
        port: livePort,
        readinessTimeoutMs: 1000,
        readinessPollMs: 10,
        sleep: livePort.sleep
      }
    });
    const getRun = setup.store.sandboxRuns.get.bind(setup.store.sandboxRuns);
    const updateWithFencing = setup.store.sandboxRuns.updateWithFencing.bind(setup.store.sandboxRuns);
    let expired = false;
    setup.store.sandboxRuns.get = async (runId) => {
      const current = await getRun(runId);
      if (current && !expired && current.phase === "starting") {
        expired = true;
        return updateWithFencing(runId, current.fencingToken, {
          ...current,
          expiresAt: "2020-01-01T00:00:00.000Z",
          fencingToken: current.fencingToken + 1,
          updatedAt: "2026-07-04T00:00:01.000Z"
        });
      }
      return current;
    };

    await assert.rejects(
      () => setup.services.tasks.createTask(setup.userId, setup.projectId, { prompt: "too late", endpointId: setup.endpointId }),
      /no longer eligible/
    );

    assert.equal(operations.includes("post"), false);
    const [task] = await setup.store.listTasksForProject(setup.projectId);
    assert.equal(task?.status, "failed");
    const run = task ? await setup.store.sandboxRuns.get(task.runId) : null;
    assert.equal(run?.phase, "cleaned");
    assert.equal(run?.cleanupStatus, "cleaned");
    assert.deepEqual(livePort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
  });

  it("rejects live sandbox creation when the namespace active run limit is reached before applying resources", async () => {
    const botified = new FakeBotifiedClient([]);
    const livePort = new FakeLiveSandboxPort({ readiness: ["ready"] });
    const resolver = new FakeCredentialResolver({
      apiKey: "sk-real-model-key",
      baseUrl: "https://models.example.com/v1/"
    });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
      sandboxNamespaceLimit: 1,
      modelCredentialResolver: resolver,
      liveSandbox: {
        port: livePort,
        readinessTimeoutMs: 1000,
        readinessPollMs: 10,
        sleep: livePort.sleep
      }
    });
    await store.sandboxRuns.put(activeSandboxRun({ namespace: "agentsmith", runId: "run-existing" }));

    await assert.rejects(
      () => services.tasks.createTask(userId, projectId, { prompt: "too many", endpointId }),
      (error) => {
        assert.ok(error instanceof ProductError);
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /Namespace sandbox active run limit reached/);
        return true;
      }
    );

    assert.deepEqual(await store.listTasksForProject(projectId), []);
    assert.deepEqual(livePort.appliedResources, []);
    assert.deepEqual(resolver.calls, []);
    assert.deepEqual(botified.postMessageCalls, []);
  });

  it("creates live Botified runtime directories under dataRoot before applying resources", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-live-dirs-"));
    const botified = new FakeBotifiedClient([{ status: "ok", events: [], nextCursor: "c0" }]);
    try {
      const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
        dataRoot,
        modelCredentialResolver: new FakeCredentialResolver({
          apiKey: "sk-real-model-key",
          baseUrl: "https://models.example.com/v1/"
        }),
        liveSandbox: {
          port: new FakeLiveSandboxPort({
            readiness: ["ready"],
            beforeApply: async (resource) => {
              const project = await store.findProject(projectId);
              assert.ok(project, "expected project fixture");
              const taskId = resource.metadata.labels["agentsmith-lite/task-id"];
              assert.ok(taskId, "expected task id label before apply");
              const taskRoot = path.join(dataRoot, project.rootPath, "tasks", taskId);

              await assertDirectory(path.join(taskRoot, "home"));
              await assertDirectory(path.join(taskRoot, "botified"));
              await assertDirectory(path.join(taskRoot, "artifacts"));
            }
          })
        }
      });

      const task = await services.tasks.createTask(userId, projectId, { prompt: "live dirs", endpointId });
      const project = await store.findProject(projectId);
      assert.ok(project, "expected project fixture");
      const taskRoot = path.join(dataRoot, project.rootPath, "tasks", task.id);

      await assertDirectory(path.join(taskRoot, "home"));
      await assertDirectory(path.join(taskRoot, "botified"));
      await assertDirectory(path.join(taskRoot, "artifacts"));
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("makes live Botified home and data directories runner-writable while keeping artifacts API-owned", async () => {
    const previousUmask = process.umask(0o022);
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-live-dir-mode-"));
    const botified = new FakeBotifiedClient([{ status: "ok", events: [], nextCursor: "c0" }]);
    try {
      const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
        dataRoot,
        modelCredentialResolver: new FakeCredentialResolver({
          apiKey: "sk-real-model-key",
          baseUrl: "https://models.example.com/v1/"
        }),
        liveSandbox: {
          port: new FakeLiveSandboxPort({
            readiness: ["ready"],
            beforeApply: async (resource) => {
              const project = await store.findProject(projectId);
              assert.ok(project, "expected project fixture");
              const taskId = resource.metadata.labels["agentsmith-lite/task-id"];
              assert.ok(taskId, "expected task id label before apply");
              const taskRoot = path.join(dataRoot, project.rootPath, "tasks", taskId);

              await assertRunnerWritableDirectory(path.join(taskRoot, "home"));
              await assertRunnerWritableDirectory(path.join(taskRoot, "botified"));
              await assertApiOwnedArtifactDirectory(path.join(taskRoot, "artifacts"));
            }
          })
        }
      });

      const task = await services.tasks.createTask(userId, projectId, { prompt: "live dir mode", endpointId });
      const project = await store.findProject(projectId);
      assert.ok(project, "expected project fixture");
      const taskRoot = path.join(dataRoot, project.rootPath, "tasks", task.id);

      await assertRunnerWritableDirectory(path.join(taskRoot, "home"));
      await assertRunnerWritableDirectory(path.join(taskRoot, "botified"));
      await assertApiOwnedArtifactDirectory(path.join(taskRoot, "artifacts"));
    } finally {
      process.umask(previousUmask);
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("does not create Botified runtime directories for dry-run tasks", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-dry-dirs-"));
    const botified = new FakeBotifiedClient([{ status: "ok", events: [], nextCursor: "c0" }]);
    try {
      const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, { dataRoot });

      const task = await services.tasks.createTask(userId, projectId, { prompt: "dry dirs", endpointId });
      const project = await store.findProject(projectId);
      assert.ok(project, "expected project fixture");

      await assertMissing(path.join(dataRoot, project.rootPath, "tasks", task.id));
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("rejects live runtime directory creation that would escape dataRoot", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-live-escape-"));
    const livePort = new FakeLiveSandboxPort({ readiness: ["ready"] });
    const botified = new FakeBotifiedClient([]);
    try {
      const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
        dataRoot,
        modelCredentialResolver: new FakeCredentialResolver({
          apiKey: "sk-real-model-key",
          baseUrl: "https://models.example.com/v1/"
        }),
        liveSandbox: {
          port: livePort,
          sleep: livePort.sleep
        }
      });
      const findProject = store.findProject.bind(store);
      store.findProject = async (id) => {
        const project = await findProject(id);
        if (project && id === projectId) {
          return { ...project, rootPath: "../escaped-project" };
        }
        return project;
      };

      await assert.rejects(
        () => services.tasks.createTask(userId, projectId, { prompt: "escape", endpointId }),
        /Task runtime directory is outside the data root/
      );
      assert.deepEqual(livePort.appliedResources, []);
      await assertMissing(path.resolve(dataRoot, "../escaped-project"));
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
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

    const task = await services.tasks.createTask(userId, projectId, { prompt: "wait for me", endpointId });

    assert.deepEqual(livePort.sleeps, [25]);
    assert.deepEqual(operations.filter((operation) => operation.startsWith("readiness:")).length, 2);
    assert.ok(operations.lastIndexOf(`readiness:${sandboxResourceNamesForTask(task.id).pod}`) < operations.indexOf("post"));
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
    const updateTaskStatusIfNonterminal = store.updateTaskStatusIfNonterminal.bind(store);
    let failedUpdateAttempts = 0;
    store.updateTaskStatusIfNonterminal = async (taskId, status, updatedAt) => {
      if (status === "failed") {
        failedUpdateAttempts += 1;
        throw new Error("store failed-state update failed");
      }
      return updateTaskStatusIfNonterminal(taskId, status, updatedAt);
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
    const postNotAcceptedRun = await postNotAccepted.store.sandboxRuns.get(
      (await postNotAccepted.store.listTasksForProject(postNotAccepted.projectId))[0]?.runId ?? ""
    );
    assert.deepEqual(postNotAcceptedRun?.startupFailure, {
      operation: "send message",
      message: "Botified did not accept task prompt",
      status: 502,
      at: postNotAcceptedRun?.startupFailure?.at
    });
    assert.ok(Date.parse(postNotAcceptedRun?.startupFailure?.at ?? ""));

    const postErrorPort = new FakeLiveSandboxPort({ readiness: ["ready"] });
    const postErrorBotified = new FakeBotifiedClient([], { postError: new Error("runtime down with sk-real-model-key") });
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
      /Botified send message failed: runtime down with sk-<redacted>/
    );
    assert.equal((await postError.store.listTasksForProject(postError.projectId))[0]?.status, "failed");
    assert.deepEqual(postErrorPort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
    const postErrorRun = await postError.store.sandboxRuns.get(
      (await postError.store.listTasksForProject(postError.projectId))[0]?.runId ?? ""
    );
    assert.deepEqual(postErrorRun?.startupFailure, {
      operation: "send message",
      message: "Botified send message failed: runtime down with sk-<redacted>",
      status: 502,
      at: postErrorRun?.startupFailure?.at
    });
    assert.ok(Date.parse(postErrorRun?.startupFailure?.at ?? ""));
  });

  it("persists live cleanup intent before aborting Botified and reaping the run", async () => {
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
      botifiedBaseUrlForTask(task.id)
    ]);
    assert.deepEqual(livePort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleaned");
  });

  it("does not overwrite a terminal task when cancel races its conditional stopping transition", async () => {
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
    const task = await services.tasks.createTask(userId, projectId, { prompt: "finish during cancel", endpointId });
    const updateTaskStatusIfNonterminal = store.updateTaskStatusIfNonterminal.bind(store);
    let completionWon = false;
    store.updateTaskStatusIfNonterminal = async (taskId, status, updatedAt) => {
      if (!completionWon && taskId === task.id && status === "stopping") {
        completionWon = true;
        const current = await store.findTask(taskId);
        assert.ok(current);
        await store.updateTask({ ...current, status: "completed", updatedAt: "2026-07-04T00:00:01.000Z" });
        return null;
      }
      return updateTaskStatusIfNonterminal(taskId, status, updatedAt);
    };

    const cancelled = await services.tasks.cancelTask(userId, task.id);

    assert.equal(cancelled.status, "completed");
    assert.equal((await store.findTask(task.id))?.status, "completed");
    assert.deepEqual(botified.abortCalls, []);
  });

  it("retains persisted live cleanup intent when Botified abort fails", async () => {
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
    assert.equal((await store.sandboxRuns.get(task.runId))?.phase, "stopping");
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleanup_requested");
  });

  it("keeps persisted stopping cleanup intent when Botified declines abort", async () => {
    const botified = new FakeBotifiedClient([{ status: "ok", events: [], nextCursor: "c0" }], {
      abortResult: { aborted: false }
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
    const task = await services.tasks.createTask(userId, projectId, { prompt: "abort declined", endpointId });

    await assert.rejects(() => services.tasks.cancelTask(userId, task.id), /Botified did not abort task/);

    const [storedTask] = await store.listTasksForProject(projectId);
    const sandboxRun = await store.sandboxRuns.get(task.runId);
    assert.equal(storedTask?.status, "stopping");
    assert.equal(sandboxRun?.phase, "stopping");
    assert.equal(sandboxRun?.cleanupStatus, "cleanup_requested");
    assert.deepEqual(livePort.deletedRefs, []);
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

  it("returns stored terminal events after live cleanup without fetching a deleted sandbox", async () => {
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
    const task = await services.tasks.createTask(userId, projectId, { prompt: "finish fast", endpointId });
    botified.readTimelineError = new Error("fetch failed");

    const events = await services.tasks.listTaskEvents(userId, task.id);

    assert.equal(task.status, "completed");
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleaned");
    assert.deepEqual(events.map((event) => [event.cursor, event.kind]), [["c1", "turn_completed"]]);
    assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), ["post-cursor"]);
  });

  it("cleans a durable terminal live run before reading stored data when Botified is gone", async () => {
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
    const task = await services.tasks.createTask(userId, projectId, { prompt: "already finished", endpointId });
    const storedAt = "2026-01-01T00:00:01.000Z";
    await store.appendTaskEvents([
      {
        id: "event-stored-terminal",
        taskId: task.id,
        kind: "turn_completed",
        cursor: "stored-c1",
        botifiedSeq: 1,
        botifiedType: "cycle.completed",
        sessionId: "s1",
        payload: { ok: true },
        createdAt: storedAt
      }
    ]);
    await store.appendTaskArtifacts([
      {
        id: "artifact-stored-terminal",
        taskId: task.id,
        fileId: "stored_file_1",
        name: "stored.txt",
        bytes: 12,
        createdAt: storedAt
      }
    ]);
    await store.updateTask({ ...task, status: "completed", updatedAt: storedAt });
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "active");
    botified.readTimelineError = new BotifiedHttpError({
      status: 404,
      code: "runtime_gone",
      message: "pod is gone",
      retryable: false,
      responseBody: { error: { code: "runtime_gone" } }
    });

    const events = await services.tasks.listTaskEvents(userId, task.id);
    const artifacts = await services.tasks.listTaskArtifacts(userId, task.id);

    assert.deepEqual(events.map((event) => [event.cursor, event.kind]), [["stored-c1", "turn_completed"]]);
    assert.deepEqual(artifacts.map((artifact) => [artifact.fileId, artifact.name, artifact.bytes]), [["stored_file_1", "stored.txt", 12]]);
    assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), ["post-cursor"]);
    assert.deepEqual(livePort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleaned");
  });

  it("continues syncing a cleaned live run until terminal events and artifacts are persisted", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-cleaned-sync-"));
    const artifactBytes = new TextEncoder().encode("artifact recovered after run cleanup");
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          {
            cursor: "c1",
            seq: 1,
            session_id: "s1",
            type: "service.status",
            data: { state: "running", queue_length: 0 }
          },
          {
            cursor: "c2",
            seq: 2,
            session_id: "s1",
            type: "cycle.started",
            data: { cycle_id: "cycle_1" }
          },
          {
            cursor: "c3",
            seq: 3,
            session_id: "s1",
            type: "command_execution.started",
            data: {
              tool_call_id: "call_bash",
              command: "printf recovered > recovered.txt",
              status: "in_progress"
            }
          },
          {
            cursor: "c4",
            seq: 4,
            session_id: "s1",
            type: "service.status",
            data: { state: "idle", queue_length: 0 }
          }
        ],
        nextCursor: "c4"
      },
      {
        status: "ok",
        events: [
          {
            cursor: "c5",
            seq: 5,
            session_id: "s1",
            type: "command_execution.completed",
            data: {
              tool_call_id: "call_bash",
              command: "printf recovered > recovered.txt",
              status: "completed",
              exit_code: 0
            }
          },
          {
            cursor: "c6",
            seq: 6,
            session_id: "s1",
            type: "file.published",
            data: {
              file_id: "recovered_file_1",
              filename: "recovered.txt",
              size_bytes: artifactBytes.byteLength
            }
          },
          {
            cursor: "c7",
            seq: 7,
            session_id: "s1",
            type: "cycle.completed",
            data: { cycle_id: "cycle_1" }
          }
        ],
        nextCursor: "c7"
      }
    ], {
      downloads: {
        recovered_file_1: artifactBytes
      }
    });
    const livePort = new FakeLiveSandboxPort({ readiness: ["ready"] });

    try {
      const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
        dataRoot,
        modelCredentialResolver: new FakeCredentialResolver({
          apiKey: "sk-real-model-key",
          baseUrl: "https://models.example.com/v1/"
        }),
        liveSandbox: {
          port: livePort,
          sleep: livePort.sleep
        }
      });
      const task = await services.tasks.createTask(userId, projectId, { prompt: "recover after cleanup", endpointId });
      const run = await store.sandboxRuns.get(task.runId);
      assert.ok(run, "expected live sandbox run");
      await store.sandboxRuns.updateWithFencing(task.runId, run.fencingToken, {
        ...run,
        phase: "cleaned",
        cleanupStatus: "cleaned",
        fencingToken: run.fencingToken + 1
      });
      const storedTask = await store.findTask(task.id);
      assert.ok(storedTask, "expected stored task");
      await store.updateTask({ ...storedTask, status: "cleaned" });

      const events = await services.tasks.listTaskEvents(userId, task.id);
      const artifacts = await store.listTaskArtifacts(task.id);

      assert.deepEqual(events.map((event) => [event.cursor, event.kind]), [
        ["c1", "diagnostic"],
        ["c2", "turn_started"],
        ["c3", "tool_execution"],
        ["c4", "diagnostic"],
        ["c5", "tool_execution"],
        ["c6", "artifact"],
        ["c7", "turn_completed"]
      ]);
      assert.deepEqual(artifacts.map((artifact) => [artifact.fileId, artifact.name, artifact.bytes]), [
        ["recovered_file_1", "recovered.txt", artifactBytes.byteLength]
      ]);
      assert.equal((await store.findTask(task.id))?.status, "completed");
      assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), ["post-cursor", "c4"]);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("handles Botified timeline reset when a new timeline reuses an old sequence number", async () => {
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          {
            cursor: "timeline:old:1",
            seq: 1,
            session_id: "s1",
            type: "assistant_message.completed",
            payload: { text: "still running" }
          }
        ],
        nextCursor: "timeline:old:1"
      },
      {
        status: "reset",
        reason: "stale_cursor",
        historyBoundary: "timeline:new:0",
        events: [
          {
            cursor: "timeline:new:1",
            seq: 1,
            session_id: "s1",
            type: "cycle.completed",
            payload: { ok: true }
          }
        ],
        nextCursor: "timeline:new:1"
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

    const task = await services.tasks.createTask(userId, projectId, { prompt: "reset then finish", endpointId });
    const events = await services.tasks.listTaskEvents(userId, task.id);

    assert.deepEqual(events.map((event) => [event.cursor, event.botifiedSeq, event.kind]), [
      ["timeline:old:1", 1, "assistant_message"],
      ["timeline:new:1", 1, "turn_completed"]
    ]);
    assert.equal((await store.findTask(task.id))?.status, "completed");
    assert.deepEqual(livePort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
    assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleaned");
    assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), ["post-cursor", "timeline:old:1"]);
  });

  it("rebuilds missing live runtime state from Botified state before syncing timeline artifacts", async () => {
    const artifactBytes = new TextEncoder().encode("rebuilt state artifact");
    const botified = new FakeBotifiedClient([
      { status: "ok", events: [], nextCursor: "timeline:main:0" },
      {
        status: "ok",
        events: [
          {
            cursor: "timeline:main:1",
            seq: 1,
            session_id: "s1",
            type: "file.published",
            payload: {
              file_id: "rebuilt_file_1",
              filename: "rebuilt.txt",
              size_bytes: artifactBytes.byteLength
            }
          }
        ],
        nextCursor: "timeline:main:1"
      }
    ], {
      downloads: {
        rebuilt_file_1: artifactBytes
      },
      stateReads: [
        {
          snapshot: {
            state: "running",
            timeline_cursor: "timeline:main:0",
            active_items: [{ id: "service", type: "service_status", status: "running" }]
          },
          state: "running",
          timelineCursor: "timeline:main:0",
          activeItems: [{ id: "service", type: "service_status", status: "running" }]
        }
      ]
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
    const task = await services.tasks.createTask(userId, projectId, { prompt: "recover state", endpointId });
    await store.jsonDocs.delete("sandbox_runtime_state", task.id);

    const artifacts = await services.tasks.listTaskArtifacts(userId, task.id);
    const runtimeState = await store.jsonDocs.get("sandbox_runtime_state", task.id);

    assert.deepEqual(botified.readStateCalls, [
      {
        baseUrl: botifiedBaseUrlForTask(task.id),
        serviceKey: "test-service-key"
      }
    ]);
    assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), ["post-cursor", "timeline:main:0"]);
    assert.deepEqual(artifacts.map((artifact) => [artifact.fileId, artifact.name, artifact.bytes]), [
      ["rebuilt_file_1", "rebuilt.txt", artifactBytes.byteLength]
    ]);
    assert.equal(runtimeState?.timelineCursor, "timeline:main:1");
    assert.equal(JSON.stringify(runtimeState).includes("test-service-key"), false);
  });

  it("keeps the projected tail cursor after reset instead of jumping to the Botified state checkpoint", async () => {
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          {
            cursor: "timeline:old:1",
            seq: 1,
            session_id: "s1",
            type: "assistant_message.completed",
            payload: { text: "still running" }
          }
        ],
        nextCursor: "timeline:old:1"
      },
      {
        status: "reset",
        reason: "stale_cursor",
        historyBoundary: "timeline:new:0",
        events: [
          {
            cursor: "timeline:new:1",
            seq: 1,
            session_id: "s1",
            type: "assistant_message.completed",
            payload: { text: "new window" }
          }
        ]
      }
    ], {
      stateReads: [
        {
          snapshot: {
            state: "running",
            timeline_cursor: "timeline:new:5",
            active_items: [{ id: "service", type: "service_status", status: "running" }]
          },
          state: "running",
          timelineCursor: "timeline:new:5",
          activeItems: [{ id: "service", type: "service_status", status: "running" }]
        }
      ]
    });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified);
    const task = await services.tasks.createTask(userId, projectId, { prompt: "stale cursor", endpointId });

    await services.tasks.listTaskEvents(userId, task.id);

    const runtimeState = await store.jsonDocs.get("sandbox_runtime_state", task.id);
    assert.equal(runtimeState?.timelineCursor, "timeline:new:1");
    assert.deepEqual(botified.readStateCalls, []);
    assert.deepEqual((await store.listTaskEvents(task.id)).map((event) => event.cursor), [
      "timeline:old:1",
      "timeline:new:1"
    ]);
  });

  it("does not persist secret-like Botified state cursors when reset has no safe tail cursor", async () => {
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          {
            cursor: "timeline:old:1",
            seq: 1,
            session_id: "s1",
            type: "assistant_message.completed",
            payload: { text: "still running" }
          }
        ],
        nextCursor: "timeline:old:1"
      },
      {
        status: "reset",
        reason: "stale_cursor",
        historyBoundary: "timeline:new:0",
        events: []
      }
    ], {
      stateReads: [
        {
          snapshot: {
            state: "running",
            timeline_cursor: "cursor-bsk_state_secret"
          },
          state: "running",
          timelineCursor: "cursor-bsk_state_secret"
        }
      ]
    });
    const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified);
    const task = await services.tasks.createTask(userId, projectId, { prompt: "secret state cursor", endpointId });

    await services.tasks.listTaskEvents(userId, task.id);

    const runtimeState = await store.jsonDocs.get("sandbox_runtime_state", task.id);
    assert.equal(runtimeState?.timelineCursor, "timeline:old:1");
    assert.deepEqual(botified.readStateCalls, [
      {
        baseUrl: botifiedBaseUrlForTask(task.id),
        serviceKey: "test-service-key"
      }
    ]);
    assert.doesNotMatch(JSON.stringify(runtimeState), /bsk_state_secret/);
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
          { cursor: "c2", seq: 2, session_id: "s1", type: "assistant_message.completed", payload: { text: "ok" } }
        ],
        nextCursor: "c2"
      },
      {
        status: "ok",
        events: [
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

    assert.equal(task.prompt, "ship");
    assert.deepEqual(events.map((event) => event.botifiedSeq), [2, 3]);
    assert.deepEqual(eventsAgain.map((event) => event.botifiedSeq), [2, 3]);
    assert.deepEqual(artifacts.map((artifact) => [artifact.fileId, artifact.name, artifact.bytes]), [["f2", "notes.md", 9]]);
    assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), ["post-cursor", "c2", "c3", "c3"]);
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
            data: {
              file_id: "file_real_1",
              filename: "../报告 final artifact.txt",
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
            data: {
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
      const artifactPath = path.join(dataRoot, project.rootPath, "tasks", task.id, "artifacts", `${artifact.id}--final-artifact.txt`);
      assert.equal(botified.downloadFileCalls[0]?.fileId, "file_real_1");
      assert.notEqual(botified.downloadFileCalls[0]?.fileId, "botified-1");

      assert.deepEqual(artifacts.map((item) => [item.fileId, item.name, item.bytes, item.sha256]), [
        ["file_real_1", "报告 final artifact.txt", artifactBytes.byteLength, "a".repeat(64)]
      ]);
      assert.equal(await readFile(artifactPath, "utf8"), "hello from published artifact");
      assert.deepEqual(botified.downloadFileCalls, [
        {
          baseUrl: botifiedBaseUrlForTask(task.id),
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
      assert.deepEqual(botified.readTimelineCalls.map((call) => call.cursor), ["post-cursor", "c1"]);
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

  it("saves a published artifact before terminal live cleanup so the copy remains downloadable", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-artifacts-terminal-"));
    const artifactBytes = new TextEncoder().encode("terminal artifact copy survives cleanup");
    const operations: string[] = [];
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
              file_id: "terminal_file_1",
              filename: "terminal.txt",
              size_bytes: artifactBytes.byteLength
            }
          },
          {
            cursor: "c2",
            seq: 2,
            session_id: "s1",
            type: "cycle.completed",
            payload: { ok: true }
          }
        ],
        nextCursor: "c2"
      }
    ], {
      downloads: {
        terminal_file_1: artifactBytes
      },
      operations
    });
    const livePort = new FakeLiveSandboxPort({ operations, readiness: ["ready"] });

    try {
      const { services, store, userId, projectId, endpointId } = await setupTaskServices(botified, {
        dataRoot,
        modelCredentialResolver: new FakeCredentialResolver({
          apiKey: "sk-real-model-key",
          baseUrl: "https://models.example.com/v1/"
        }),
        liveSandbox: {
          port: livePort,
          sleep: livePort.sleep
        }
      });
      const task = await services.tasks.createTask(userId, projectId, { prompt: "publish and finish", endpointId });
      const artifact = (await store.listTaskArtifacts(task.id))[0];
      assert.ok(artifact, "expected terminal batch to persist an artifact");
      botified.readTimelineError = new BotifiedHttpError({
        status: 404,
        code: "runtime_gone",
        message: "runtime cleaned up",
        retryable: false,
        responseBody: { error: { code: "runtime_gone" } }
      });

      const downloaded = await services.tasks.downloadTaskArtifact(userId, task.id, artifact.id);

      assert.equal(task.status, "completed");
      assert.equal((await store.sandboxRuns.get(task.runId))?.cleanupStatus, "cleaned");
      assert.deepEqual(livePort.deletedRefs.map((ref) => ref.kind), ["Pod", "Service", "NetworkPolicy", "ConfigMap", "Secret", "ServiceAccount"]);
      assert.ok(operations.indexOf("download:terminal_file_1") < operations.indexOf("delete:Pod"));
      assert.equal(downloaded.bytes.toString("utf8"), "terminal artifact copy survives cleanup");
      assert.deepEqual(botified.downloadFileCalls.map((call) => call.fileId), ["terminal_file_1"]);
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
        baseUrl: botifiedBaseUrlForTask(task.id),
        serviceKey: "test-service-key"
      }
    ]);
  });
});

function botifiedBaseUrlForTask(taskId: string, namespace = "agentsmith", port = 3099): string {
  return `http://${sandboxServiceNameForTask(taskId)}.${namespace}.svc.cluster.local:${port}`;
}

function assertDnsLabel(name: string): void {
  assert.match(name, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, `${name} should be a DNS label`);
  assert.ok(name.length <= 63, `${name} should fit in a DNS label`);
  assert.equal(name.includes("_"), false, `${name} should not contain underscores`);
}

function hasPort(rule: NetworkPolicyEgressRule, protocol: string, port: number): boolean {
  return rule.ports?.some((candidate) => candidate.protocol === protocol && candidate.port === port) ?? false;
}

function hasUnscopedDestination(rule: NetworkPolicyEgressRule): boolean {
  return rule.to === undefined || rule.to.length === 0;
}

function hasAgentsmithLocalOpenAiDestination(rule: NetworkPolicyEgressRule): boolean {
  return (
    rule.to?.some(
      (destination) =>
        JSON.stringify(destination.namespaceSelector) ===
          JSON.stringify({ matchLabels: { "kubernetes.io/metadata.name": "agentsmith" } }) &&
        JSON.stringify(destination.podSelector) ===
          JSON.stringify({ matchLabels: { "app.kubernetes.io/name": "agentsmith-lite-local-openai" } })
    ) ?? false
  );
}

interface SetupOptions {
  serviceKeyFactory?: () => string | undefined;
  dataRoot?: string;
  endpointBaseUrl?: string;
  endpointCapabilities?: Array<"text" | "image" | "tool_calls">;
  modelCredentialResolver?: ModelCredentialResolver;
  liveSandbox?: CreateApplicationServicesInput["liveSandbox"];
  sandboxNamespaceLimit?: number;
  liveSandboxMaxLifetimeMs?: number;
  liveSandboxIdleTimeoutMs?: number;
  modelCa?: CreateApplicationServicesInput["modelCa"];
}

async function setupTaskServices(botified: FakeBotifiedClient, optionsOrFactory: SetupOptions | (() => string | undefined) = {}) {
  const options: SetupOptions = typeof optionsOrFactory === "function" ? { serviceKeyFactory: optionsOrFactory } : optionsOrFactory;
  const store = createInMemoryProductStore();
  const builtinAdminPassword = options.liveSandbox ? "test-admin-password" : "admin-password";
  const services = createApplicationServices({
    store,
    dataRoot: options.dataRoot ?? path.join(tmpdir(), "agentsmith-lite-task-service"),
    builtinAdminPassword,
    sessionSecret: "test-session-secret-at-least-32-chars",
    botifiedClient: botified,
    botifiedServiceKeyFactory: options.serviceKeyFactory ?? (() => "test-service-key"),
    ...(options.modelCredentialResolver ? { modelCredentialResolver: options.modelCredentialResolver } : {}),
    ...(options.sandboxNamespaceLimit !== undefined ? { sandboxNamespaceLimit: options.sandboxNamespaceLimit } : {}),
    ...(options.liveSandboxMaxLifetimeMs !== undefined ? { liveSandboxMaxLifetimeMs: options.liveSandboxMaxLifetimeMs } : {}),
    ...(options.liveSandboxIdleTimeoutMs !== undefined ? { liveSandboxIdleTimeoutMs: options.liveSandboxIdleTimeoutMs } : {}),
    ...(options.modelCa ? { modelCa: options.modelCa } : {}),
    ...(options.liveSandbox ? { liveSandbox: options.liveSandbox } : {})
  });
  const { user } = await services.auth.loginAfterBootstrap(builtinAdminPassword);
  const workspace = await services.workspaces.createWorkspace(user.id, { name: "Workspace" });
  const project = await services.workspaces.createProject(user.id, workspace.id, { name: "Project" });
  const endpoint = await services.endpoints.createEndpoint(user.id, project.id, {
    name: "openai-compatible",
    protocol: "openai_chat_completions",
    baseUrl: options.endpointBaseUrl ?? "https://models.example.com/v1",
    model: "gpt-compatible",
    apiKeySecretRef: "secret/openai",
    capabilities: options.endpointCapabilities ?? ["text", "tool_calls"],
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

function activeSandboxRun(input: { namespace: string; runId: string }): PersistedSandboxRunState {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    namespace: input.namespace,
    workspaceId: "workspace-existing",
    projectId: "project-existing",
    taskId: "task-existing",
    runId: input.runId,
    phase: "running",
    image: "agentsmith-lite/botified-runner:dev",
    pvcName: "agentsmith-lite-files",
    projectSubPath: "workspaces/workspace-existing/projects/project-existing",
    botifiedPort: 3099,
    resourceNames: {
      pod: "asl-task-existing",
      service: "asl-task-existing",
      configMap: "asl-task-existing-config",
      secret: "asl-botified-existing",
      serviceAccount: "asl-task-existing",
      networkPolicy: "asl-task-existing"
    },
    serviceKeySecretRef: {
      name: "asl-botified-existing",
      key: "BOTIFIED_SERVICE_KEY"
    },
    directories: {
      taskHome: "/workspace/project/tasks/task-existing/home",
      artifacts: "/workspace/project/tasks/task-existing/artifacts",
      botified: "/workspace/project/tasks/task-existing/botified"
    },
    resourceLimits: {
      cpuRequest: "250m",
      memoryRequest: "512Mi",
      cpuLimit: "1",
      memoryLimit: "1Gi"
    },
    fencingToken: 1,
    cleanupStatus: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function assertDirectory(directory: string): Promise<void> {
  const stats = await stat(directory);
  assert.equal(stats.isDirectory(), true, `${directory} should be a directory`);
}

async function assertRunnerWritableDirectory(directory: string): Promise<void> {
  const stats = await stat(directory);
  assert.equal(stats.isDirectory(), true, `${directory} should be a directory`);
  const mode = stats.mode & 0o777;
  const ownerWritable = stats.uid === BOTIFIED_RUNNER_ID && (mode & 0o300) === 0o300;
  const groupWritable = stats.gid === BOTIFIED_RUNNER_ID && (mode & 0o030) === 0o030;
  const otherWritable = (mode & 0o003) === 0o003;
  assert.equal(
    ownerWritable || groupWritable || otherWritable,
    true,
    `${directory} mode ${mode.toString(8)} uid ${stats.uid} gid ${stats.gid} should let runner 10001 create files`
  );
}

async function assertApiOwnedArtifactDirectory(directory: string): Promise<void> {
  const stats = await stat(directory);
  assert.equal(stats.isDirectory(), true, `${directory} should be a directory`);
  const mode = stats.mode & 0o777;
  assert.equal((mode & 0o002), 0, `${directory} mode ${mode.toString(8)} should not be writable by arbitrary users`);
  if (process.getuid?.() !== BOTIFIED_RUNNER_ID) {
    assert.notEqual(stats.uid, BOTIFIED_RUNNER_ID, `${directory} should not be chowned to the Botified runner uid`);
  }
  if (process.getgid?.() !== BOTIFIED_RUNNER_ID) {
    assert.equal(
      stats.gid === BOTIFIED_RUNNER_ID && (mode & 0o020) !== 0,
      false,
      `${directory} should not be group-writable by the Botified runner gid`
    );
  }
}

async function assertMissing(candidate: string): Promise<void> {
  await assert.rejects(() => access(candidate), { code: "ENOENT" });
}

const BOTIFIED_RUNNER_ID = 10001;

class FakeBotifiedClient implements BotifiedRuntimeHttpClient {
  readonly postMessageCalls: Array<{ baseUrl: string; serviceKey: string; message: string }> = [];
  readonly readStateCalls: Array<{ baseUrl: string; serviceKey: string }> = [];
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
      abortResult?: BotifiedAbortResult;
      stateReads?: BotifiedRuntimeStateResult[];
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

  async readState(baseUrl: string, serviceKey: string): Promise<BotifiedRuntimeStateResult> {
    this.readStateCalls.push({ baseUrl, serviceKey });
    return this.options.stateReads?.shift() ?? { snapshot: {}, state: "running" };
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
    this.options.operations?.push(`download:${fileId}`);
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
    return this.options.abortResult ?? { aborted: true };
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
  readonly sleeps: number[] = [];
  readonly sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
  };
  taskId = "";

  private readonly operations: string[] | undefined;
  private readonly readiness: PodReadiness[];
  private readonly applyResults: Array<"applied" | "fence_mismatch" | Error>;
  private readonly beforeApply: ((resource: KubernetesResource) => void | Promise<void>) | undefined;
  private resources: KubernetesResource[] = [];

  constructor(input: {
    operations?: string[];
    readiness?: PodReadiness[];
    applyResults?: Array<"applied" | "fence_mismatch" | Error>;
    beforeApply?: (resource: KubernetesResource) => void | Promise<void>;
  } = {}) {
    this.operations = input.operations;
    this.readiness = [...(input.readiness ?? ["ready"])];
    this.applyResults = [...(input.applyResults ?? [])];
    this.beforeApply = input.beforeApply;
  }

  async listManagedResources(): Promise<KubernetesResource[]> {
    return this.resources.map((resource) => structuredClone(resource));
  }

  async applyResource(resource: KubernetesResource, expectedLabels: Record<string, string>): Promise<"applied" | "fence_mismatch"> {
    await this.beforeApply?.(resource);
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

interface NetworkPolicyResource extends KubernetesResource {
  spec: {
    egress: NetworkPolicyEgressRule[];
  };
}

interface NetworkPolicyEgressRule {
  to?: Array<{
    namespaceSelector?: Record<string, unknown>;
    podSelector?: Record<string, unknown>;
    ipBlock?: Record<string, unknown>;
  }>;
  ports?: Array<{ protocol: string; port: number }>;
}

interface PodResource extends KubernetesResource {
  spec: {
    containers: Array<{
      volumeMounts: Array<{ name: string; mountPath: string; subPath?: string; readOnly?: boolean }>;
    }>;
    volumes: Array<{
      name: string;
      configMap?: {
        name: string;
        items?: Array<{ key: string; path: string }>;
      };
    }>;
  };
}
