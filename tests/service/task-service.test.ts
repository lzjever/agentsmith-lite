import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApplicationServices } from "../../packages/application/src/factory.js";
import type {
  BotifiedAbortResult,
  BotifiedPostMessageResult,
  BotifiedRuntimeHttpClient,
  BotifiedTimelineReadResult,
  BotifiedUploadFileInput,
  BotifiedUploadFileResult
} from "../../packages/ports/src/botified.js";

describe("task service Botified orchestration", () => {
  it("sends the prompt through Botified, stores projected events, and keeps service keys server-side", async () => {
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          { cursor: "c1", seq: 1, session_id: "s1", type: "input.accepted", payload: { text: "build it" } },
          { cursor: "c2", seq: 2, session_id: "s1", type: "assistant_message.completed", payload: { text: "working" } },
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

    const events = await store.listTaskEvents(task.id);
    assert.deepEqual(events.map((event) => event.kind), ["user_input", "assistant_message", "artifact"]);
    assert.deepEqual(events.map((event) => event.botifiedSeq), [1, 2, 3]);
    assert.equal(events[0]?.payload.text, "build it");
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

  it("syncs timeline events idempotently before returning task events and artifacts", async () => {
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

async function setupTaskServices(botified: FakeBotifiedClient, serviceKeyFactory = () => "test-service-key") {
  const store = createInMemoryProductStore();
  const services = createApplicationServices({
    store,
    dataRoot: "/agentsmith-lite",
    builtinAdminPassword: "admin-password",
    botifiedClient: botified,
    botifiedServiceKeyFactory: serviceKeyFactory
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
  readonly abortCalls: Array<{ baseUrl: string; serviceKey: string }> = [];

  constructor(private readonly timelineReads: BotifiedTimelineReadResult[]) {}

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

  async abort(baseUrl: string, serviceKey: string): Promise<BotifiedAbortResult> {
    this.abortCalls.push({ baseUrl, serviceKey });
    return { aborted: true };
  }
}
