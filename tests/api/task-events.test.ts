import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createApiServer as createRawApiServer, type ApiServerOptions, type RunningApiServer } from "../../packages/api-entry-node/src/server.js";
import {
  type BotifiedAbortResult,
  type BotifiedDeliveryMessageInput,
  type BotifiedDeliveryReceipt,
  type BotifiedPostMessageResult,
  type BotifiedRuntimeHttpClient,
  type BotifiedTimelineReadResult,
  type BotifiedUploadFileInput,
  type BotifiedUploadFileResult
} from "../../packages/ports/src/botified.js";

const validProductionSessionSecret = "production-session-secret-32-chars";
const createApiServer = (options: ApiServerOptions) => createRawApiServer({
  ...options,
  providerClient: {
    async validateEndpoint() { return { status: "healthy" as const }; },
    async completeChat() { throw new Error("not used"); }
  }
});

describe("task events API", () => {
  let api: RunningApiServer | undefined;
  let dataRoot = "";

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-task-api-"));
  });

  afterEach(async () => {
    await api?.close();
    api = undefined;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("returns and downloads server-projected artifacts without UI-facing Botified routes or secrets", async () => {
    const store = createLocalInMemoryProductStore();
    const artifactBytes = new TextEncoder().encode("api artifact bytes");
    const botified = new FakeBotifiedClient([
      {
        status: "ok",
        events: [
          {
            cursor: "c2",
            seq: 2,
            session_id: "s1",
            type: "file.published",
            payload: {
              file_id: "f1",
              filename: "../bad/报告\"\r\n.txt",
              mime_type: "text/markdown",
              size_bytes: artifactBytes.byteLength,
              sha256: "6c839ab9cab51908aff7e97713dfeaf25eec58eb99b3ed52b31dfedf4b0699d3",
              download_url: "http://botified.internal/v1/files/f1?service_key=api-service-key"
            }
          }
        ],
        nextCursor: "c2"
      }
    ]);
    botified.downloads.f1 = artifactBytes;
    api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password",
      botifiedClient: botified,
      botifiedServiceKeyFactory: () => "api-service-key",
      store
    });
    const auth = await createProjectWithEndpoint(api.baseUrl);

    const task = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, {
      prompt: "make notes",
      endpointId: auth.endpointId
    });
    const stored = await store.findTask(task.id as string);
    assert.ok(stored);
    await store.updateTask({ ...stored, executionMode: "live", status: "running", terminalReason: null, terminalizedAt: null, startIntentStatus: "dispatched", artifactProjectionStatus: "pending", cleanupStatus: "pending", cleanupCompletedAt: null });
    await store.jsonDocs.put("sandbox_runtime_state", task.id as string, { botifiedBaseUrl: "http://botified.internal" });
    const events = await auth.requestJson("GET", `/api/v1/tasks/${task.id}/events`);
    const artifacts = await auth.requestJson("GET", `/api/v1/tasks/${task.id}/artifacts`);
    const leakedJson = JSON.stringify({ events, artifacts });

    assert.deepEqual(events.map((event: { kind: string; botifiedSeq: number }) => [event.kind, event.botifiedSeq]), [
      ["artifact", 2]
    ]);
    assert.equal(task.prompt, "make notes");
    assert.equal(task.executionMode, "dry-run");
    assert.deepEqual(artifacts.map((artifact: { fileId: string; name: string; bytes: number; sha256?: string }) => [
      artifact.fileId,
      artifact.name,
      artifact.bytes,
      artifact.sha256
    ]), [["f1", "报告\".txt", artifactBytes.byteLength, "6c839ab9cab51908aff7e97713dfeaf25eec58eb99b3ed52b31dfedf4b0699d3"]]);
    assert.equal(botified.readTimelineCalls[0]?.serviceKey, "api-service-key");
    assert.equal(botified.downloadFileCalls[0]?.serviceKey, "api-service-key");
    assert.doesNotMatch(leakedJson, /api-service-key|botified\.internal|download_url|\/v1\/files/);

    const anonymousDownload = await fetch(`${api.baseUrl}/api/v1/tasks/${task.id}/artifacts/${artifacts[0].id}/download`);
    assert.equal(anonymousDownload.status, 401);

    const download = await auth.request("GET", `/api/v1/tasks/${task.id}/artifacts/${artifacts[0].id}/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "text/plain");
    assert.equal(download.headers.get("content-length"), String(artifactBytes.byteLength));
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      download.headers.get("content-disposition"),
      "attachment; filename=\"___.txt\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A_.txt"
    );
    const headerFilename = /^attachment; filename="([^"]+)"(?:; filename\*=UTF-8''[^;]+)?$/.exec(download.headers.get("content-disposition") ?? "")?.[1] ?? "";
    assert.doesNotMatch(headerFilename, /[\r\n\\"/\u0080-\uffff]/);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), artifactBytes);
    const downloadHeaders: string[] = [];
    download.headers.forEach((value, key) => downloadHeaders.push(`${key}: ${value}`));
    assert.doesNotMatch(JSON.stringify(downloadHeaders), /api-service-key|botified\.internal|download_url|\/v1\/files/);
  });

  it("uses a safe download header for persisted artifact names with path and control characters", async () => {
    const artifactBytes = new TextEncoder().encode("persisted artifact bytes");
    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([{ status: "ok", events: [], nextCursor: "c0" }]);
    api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password",
      botifiedClient: botified,
      botifiedServiceKeyFactory: () => "api-service-key",
      store
    });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const task = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, {
      prompt: "download old artifact",
      endpointId: auth.endpointId
    });
    const artifact = {
      id: "art_header",
      taskId: task.id as string,
      fileId: "f1",
      name: "../bad/报告\"\r\n.txt",
      bytes: artifactBytes.byteLength,
      sha256: "c".repeat(64),
      createdAt: new Date(0).toISOString()
    };
    await store.appendTaskArtifacts([artifact]);
    const project = await store.findProject(auth.projectId);
    assert.ok(project);
    const artifactDir = path.resolve(dataRoot, project.rootPath, "tasks", task.id as string, "artifacts");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "art_header--.txt"), artifactBytes);

    const download = await auth.request("GET", `/api/v1/tasks/${task.id}/artifacts/${artifact.id}/download`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/octet-stream");
    assert.equal(download.headers.get("content-length"), String(artifactBytes.byteLength));
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      download.headers.get("content-disposition"),
      "attachment; filename=\"_____.txt\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A___.txt"
    );
    const filename = /^attachment; filename="([^"]+)"(?:; filename\*=UTF-8''[^;]+)?$/.exec(download.headers.get("content-disposition") ?? "")?.[1] ?? "";
    assert.doesNotMatch(filename, /[\r\n\\"/\u0080-\uffff]/);
    assert.doesNotMatch(download.headers.get("content-disposition") ?? "", /api-service-key|botified\.internal|download_url|service_key/);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), artifactBytes);
  });

  it("starts a linked successor when a terminal task receives a follow-up", async () => {
    const store = createLocalInMemoryProductStore();
    const botified = new FakeBotifiedClient([]);
    api = await createApiServer({ port: 0, dataRoot, builtinAdminPassword: "admin-password", botifiedClient: botified, botifiedServiceKeyFactory: () => "api-service-key", store });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const source = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, { prompt: "source task", endpointId: auth.endpointId });
    const persistedSource = await store.findTask(source.id as string);
    assert.ok(persistedSource);
    await store.updateTask({ ...persistedSource, status: "completed", updatedAt: "2026-07-11T00:00:00.000Z" });

    const followUp = await auth.requestJson("POST", `/api/v1/tasks/${source.id}/follow-ups`, { prompt: "continue from the completed result" });
    assert.equal(followUp.taskId, source.id);
    assert.ok(followUp.followUpTaskId);

    const unchangedSource = await auth.requestJson("GET", `/api/v1/tasks/${source.id}`);
    const successor = await auth.requestJson("GET", `/api/v1/tasks/${followUp.followUpTaskId}`);
    assert.equal(unchangedSource.status, "completed");
    assert.equal(successor.sourceTaskId, source.id);
    assert.equal(successor.prompt, "continue from the completed result");
    assert.equal(successor.endpointId, auth.endpointId);
    assert.equal(successor.terminalReason, "not_executed");
    assert.equal(botified.postMessageCalls.length, 0);
  });

  it("keeps dry-run not_executed first-wins when cancellation is requested", async () => {
    const botified = new FakeBotifiedClient([{ status: "ok", events: [], nextCursor: "c0" }]);
    api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password",
      botifiedClient: botified,
      botifiedServiceKeyFactory: () => "api-service-key"
    });
    const auth = await createProjectWithEndpoint(api.baseUrl);
    const task = await auth.requestJson("POST", `/api/v1/projects/${auth.projectId}/tasks`, {
      prompt: "cancel me",
      endpointId: auth.endpointId
    });

    const cancelled = await auth.requestJson("POST", `/api/v1/tasks/${task.id}/cancel`, {});
    assert.equal(cancelled.status, "completed");
    assert.equal(cancelled.terminalReason, "not_executed");
    assert.equal(botified.abortCalls.length, 0);
  });

  it("fails fast when live sandbox mode has no persistent product store", async () => {
    const previousPostgresUrl = process.env.POSTGRES_APP_URL;
    delete process.env.POSTGRES_APP_URL;
    try {
      await assert.rejects(
        () =>
          createApiServer({
            port: 0,
            dataRoot,
            builtinAdminPassword: "admin-password",
            liveSandbox: {
              port: {
                applyResource: async () => "applied" as const,
                deleteResource: async () => "deleted" as const,
                getPodReadiness: async () => "ready" as const,
                listManagedResources: async () => []
              }
            }
          }),
        /POSTGRES_APP_URL is required/
      );
    } finally {
      if (previousPostgresUrl === undefined) {
        delete process.env.POSTGRES_APP_URL;
      } else {
        process.env.POSTGRES_APP_URL = previousPostgresUrl;
      }
    }
  });

  it("fails fast when live sandbox mode would use a missing, default, or weak session secret", async () => {
    const previousPostgresUrl = process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL = "postgresql://app:secret@db/app";
    const liveSandbox = {
      port: {
        applyResource: async () => "applied" as const,
        deleteResource: async () => "deleted" as const,
        getPodReadiness: async () => "ready" as const,
        listManagedResources: async () => []
      }
    };

    try {
      for (const sessionSecret of [undefined, "", "dev-session-secret", " dev-session-secret ", "short-production-secret"]) {
        await assert.rejects(
          () =>
            createApiServer({
              port: 0,
              dataRoot,
              builtinAdminPassword: "production-admin-password",
              ...(sessionSecret !== undefined ? { sessionSecret } : {}),
              liveSandbox
            }),
          /APP_SESSION_SECRET must be set to a non-default value of at least 32 characters/
        );
      }

      api = await createApiServer({
        port: 0,
        dataRoot,
        builtinAdminPassword: "production-admin-password",
        sessionSecret: validProductionSessionSecret,
        liveSandbox,
        store: createLocalInMemoryProductStore()
      });
      assert.match(api.baseUrl, /^http:\/\/127\.0\.0\.1:/);
    } finally {
      if (previousPostgresUrl === undefined) {
        delete process.env.POSTGRES_APP_URL;
      } else {
        process.env.POSTGRES_APP_URL = previousPostgresUrl;
      }
    }
  });

  it("fails fast when live sandbox mode would use the default admin password", async () => {
    const previousPostgresUrl = process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL = "postgresql://app:secret@db/app";
    const liveSandbox = {
      port: {
        applyResource: async () => "applied" as const,
        deleteResource: async () => "deleted" as const,
        getPodReadiness: async () => "ready" as const,
        listManagedResources: async () => []
      }
    };

    try {
      for (const builtinAdminPassword of ["", "admin-password", " admin-password "]) {
        await assert.rejects(
          () =>
            createApiServer({
              port: 0,
              dataRoot,
              builtinAdminPassword,
              sessionSecret: validProductionSessionSecret,
              liveSandbox
            }),
          /BUILTIN_ADMIN_INITIAL_PASSWORD must be set to a non-default value/
        );
      }
    } finally {
      if (previousPostgresUrl === undefined) {
        delete process.env.POSTGRES_APP_URL;
      } else {
        process.env.POSTGRES_APP_URL = previousPostgresUrl;
      }
    }
  });
});

async function createProjectWithEndpoint(baseUrl: string) {
  let idempotencySequence = 0;
  await fetch(baseUrl + "/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "admin-password" })
  });
  const login = await fetch(baseUrl + "/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "admin@agentsmith-lite.local",
      password: "admin-password"
    })
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const csrf = (await login.json() as { csrfToken: string }).csrfToken;

  const request = async (method: string, pathname: string, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json", cookie };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers["x-csrf-token"] = csrf;
    }
    if (pathname.includes("/tasks") && ["POST", "PATCH", "DELETE"].includes(method)) {
      headers["idempotency-key"] = `task-events-${++idempotencySequence}`;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    return fetch(baseUrl + pathname, init);
  };
  const requestJson = async (method: string, pathname: string, body?: unknown) => {
    const response = await request(method, pathname, body);
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    return response.json();
  };

  const workspace = await requestJson("POST", "/api/v1/workspaces", { name: "Ops" });
  const project = await requestJson("POST", `/api/v1/workspaces/${workspace.id}/projects`, { name: "Demo" });
  const credential = await requestJson("POST", `/api/v1/projects/${project.id}/credentials`, { name: "Mock credential", baseUrl: "https://models.example.com/v1", secret: "sk-real-model-key" });
  const endpoint = await requestJson("POST", `/api/v1/projects/${project.id}/endpoints`, {
    name: "Mock endpoint",
    protocol: "openai_chat_completions",
    baseUrl: "https://models.example.com/v1",
    model: "gpt-compatible",
    credentialId: credential.id,
    capabilities: ["text", "tool_calls"],
    requestTimeoutSecs: 30
  });

  return {
    projectId: project.id as string,
    endpointId: endpoint.id as string,
    request,
    requestJson
  };
}

class FakeBotifiedClient implements BotifiedRuntimeHttpClient {
  readonly postMessageCalls: Array<{ baseUrl: string; serviceKey: string; message: string }> = [];
  readonly readTimelineCalls: Array<{ baseUrl: string; serviceKey: string; cursor: string | undefined }> = [];
  readonly downloadFileCalls: Array<{ baseUrl: string; serviceKey: string; fileId: string }> = [];
  readonly abortCalls: Array<{ baseUrl: string; serviceKey: string }> = [];
  readonly downloads: Record<string, Uint8Array> = {};
  abortError: unknown;

  constructor(private readonly timelineReads: BotifiedTimelineReadResult[]) {}

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
    const bytes = this.downloads[fileId] ?? new Uint8Array();
    return {
      bytes,
      filename: `${fileId}.txt`,
      mimeType: "application/octet-stream",
      sizeBytes: bytes.byteLength
    };
  }

  async abort(baseUrl: string, serviceKey: string): Promise<BotifiedAbortResult> {
    this.abortCalls.push({ baseUrl, serviceKey });
    if (this.abortError) {
      throw this.abortError;
    }
    return { aborted: true };
  }
}
