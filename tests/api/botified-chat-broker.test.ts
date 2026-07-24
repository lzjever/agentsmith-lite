import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { createTestApiServer as createApiServer } from "../../packages/api-entry-node/src/server.js";
import type { KubernetesResource } from "../../packages/contracts/src/api.js";
import { FetchOpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";
import type {
  BotifiedAbortResult,
  BotifiedDeliveryMessageInput,
  BotifiedDeliveryReceipt,
  BotifiedDownloadFileResult,
  BotifiedPostMessageResult,
  BotifiedRuntimeHttpClient,
  BotifiedTimelineReadResult,
  BotifiedUploadFileInput,
  BotifiedUploadFileResult
} from "../../packages/ports/src/botified.js";
import type { KubernetesResourceRef, PodReadiness, SandboxKubernetesMutationPort, SandboxKubernetesReadinessPort } from "../../packages/sandbox-controller/src/kubernetesPort.js";

describe("Botified Chat Completions broker", () => {
  let baseUrl = "";
  let dataRoot = "";
  let close: (() => Promise<void>) | undefined;
  let previousPostgresUrl: string | undefined;
  let providerResponseFactory: (() => Response | Promise<Response>) | undefined;
  const providerCalls: Array<{ url: string; authorization: string | null; body: string; headers: Headers }> = [];

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-broker-"));
    previousPostgresUrl = process.env.POSTGRES_APP_URL;
    process.env.POSTGRES_APP_URL = "postgresql://broker-test-required-persistent-store";
    const api = await createApiServer({
      port: 0,
      dataRoot,
      store: createLocalInMemoryProductStore(),
      builtinAdminPassword: "broker-test-admin-password",
      sessionSecret: "broker-test-session-secret-at-least-32-characters",
      publicBaseUrl: "https://agentsmith.example/app",
      botifiedServiceKeyFactory: ({ taskId, runId }) => `task-key:${taskId}:${runId}`,
      botifiedClient: new AcceptingBotifiedClient(),
      liveSandbox: {
        port: new ReadySandboxPort(),
        readinessTimeoutMs: 10,
        readinessPollMs: 1,
        sleep: async () => undefined
      },
      runtimeTickIntervalMs: 5,
      providerClient: new FetchOpenAICompatibleClient(async (url, init) => {
        providerCalls.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string"
            ? init.body
            : new TextDecoder().decode(init?.body as Uint8Array),
          headers: new Headers(init?.headers)
        });
        return providerResponseFactory?.() ?? new Response(
          "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"bash\"}}]}}]}\n\ndata: [DONE]\n\n",
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "content-encoding": "gzip",
              "content-length": "42",
              "x-request-id": "provider-request"
            }
          }
        );
      })
    });
    baseUrl = api.baseUrl;
    close = api.close;
  });

  beforeEach(() => {
    providerCalls.length = 0;
    providerResponseFactory = undefined;
  });

  after(async () => {
    await close?.();
    await rm(dataRoot, { recursive: true, force: true });
    if (previousPostgresUrl === undefined) {
      delete process.env.POSTGRES_APP_URL;
    } else {
      process.env.POSTGRES_APP_URL = previousPostgresUrl;
    }
  });

  it("uses the prefix-independent in-cluster route and transparently forwards streaming tool calls", async () => {
    const { task, projectId, cookie, userId } = await createTask("one");
    const requestBody = {
      model: "gpt-compatible",
      messages: [{ role: "user", content: "run a command" }],
      tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
      stream: true
    };
    const response = await fetch(
      `${baseUrl}/api/internal/tasks/${task.id}/runs/${task.runId}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer task-key:${task.id}:${task.runId}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-untrusted-header": "must-not-reach-provider"
        },
        body: JSON.stringify(requestBody)
      }
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(response.headers.get("x-request-id"), "provider-request");
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("content-length"), null);
    assert.match(await response.text(), /tool_calls/);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0]?.url, "https://models.example.com/v1/chat/completions");
    assert.equal(providerCalls[0]?.authorization, "Bearer sk-provider-key");
    assert.equal(providerCalls[0]?.headers.get("x-untrusted-header"), null);
    assert.deepEqual(JSON.parse(providerCalls[0]?.body ?? ""), requestBody);
    const usage = await fetch(`${baseUrl}/app/api/v1/projects/${projectId}/usage`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(usage.provider.userId, userId);
    assert.deepEqual(usage.provider.totals, { requests: 1, tokens: 0, cost: 0 });
    assert.deepEqual(
      Object.fromEntries(
        usage.limits
          .filter((limit: { metric: string }) => ["providerRequests", "providerTokens", "providerCost"].includes(limit.metric))
          .map((limit: { metric: string; current: number }) => [limit.metric, limit.current])
      ),
      { providerRequests: 2, providerTokens: 4096, providerCost: 1 }
    );
  });

  it("rejects invalid and cross-task keys before provider forwarding", async () => {
    const { task: first } = await createTask("first");
    const { task: second } = await createTask("second");
    const invalid = await fetch(`${baseUrl}/api/internal/tasks/${first.id}/runs/${first.runId}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-task-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "ignored", messages: [] })
    });
    const mismatched = await fetch(`${baseUrl}/api/internal/tasks/${second.id}/runs/${second.runId}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer task-key:${first.id}:${first.runId}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "ignored", messages: [] })
    });

    assert.equal(invalid.status, 401);
    assert.equal(mismatched.status, 401);
    assert.equal(providerCalls.length, 0);
  });

  it("rejects a wrong run, invalid model, unsupported fields, and oversized broker bodies without calling the provider", async () => {
    const { task } = await createTask("constraints");
    const endpoint = `${baseUrl}/api/internal/tasks/${task.id}/runs/${task.runId}/v1/chat/completions`;
    const headers = { authorization: `Bearer task-key:${task.id}:${task.runId}`, "content-type": "application/json" };

    const wrongRun = await fetch(`${baseUrl}/api/internal/tasks/${task.id}/runs/not-${task.runId}/v1/chat/completions`, {
      method: "POST", headers, body: JSON.stringify({ model: "gpt-compatible", messages: [{ role: "user", content: "no" }] })
    });
    const malformedRoute = await fetch(`${baseUrl}/api/internal/tasks/%E0%A4%A/runs/${task.runId}/v1/chat/completions`, {
      method: "POST", headers, body: JSON.stringify({ model: "gpt-compatible", messages: [{ role: "user", content: "no" }] })
    });
    const wrongModel = await fetch(endpoint, {
      method: "POST", headers, body: JSON.stringify({ model: "other-model", messages: [{ role: "user", content: "no" }] })
    });
    const unsupported = await fetch(endpoint, {
      method: "POST", headers, body: JSON.stringify({ model: "gpt-compatible", messages: [{ role: "user", content: "no" }], api_key: "sk-client-secret" })
    });
    const oversized = await fetch(endpoint, {
      method: "POST", headers, body: JSON.stringify({ model: "gpt-compatible", messages: [{ role: "user", content: "x".repeat(1_048_576) }] })
    });
    assert.equal(wrongRun.status, 401);
    assert.equal(malformedRoute.status, 400);
    assert.equal(wrongModel.status, 403);
    assert.equal(unsupported.status, 400);
    assert.equal(oversized.status, 413);
    assert.equal(providerCalls.length, 0);
    assert.doesNotMatch(await unsupported.text(), /sk-provider-key|sk-client-secret/);
  });

  it("forwards the first SSE frame before the provider closes and settles terminal usage", async () => {
    const { task, projectId, cookie } = await createTask("incremental-sse");
    const encoder = new TextEncoder();
    let release!: () => void;
    providerResponseFactory = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n"));
        release = () => {
          controller.enqueue(encoder.encode("data: {\"usage\":{\"total_tokens\":9}}\n\ndata: [DONE]\n\n"));
          controller.close();
        };
      }
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    const response = await fetch(`${baseUrl}/api/internal/tasks/${task.id}/runs/${task.runId}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer task-key:${task.id}:${task.runId}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ model: "gpt-compatible", messages: [{ role: "user", content: "stream" }], stream: true })
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.match(new TextDecoder().decode(first.value), /first/);

    release();
    let remainder = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder += new TextDecoder().decode(chunk.value);
    }
    assert.match(remainder, /total_tokens/);

    const { provider } = await fetch(`${baseUrl}/app/api/v1/projects/${projectId}/usage`, { headers: { cookie } }).then((result) => result.json());
    assert.deepEqual(provider.totals, { requests: 2, tokens: 9, cost: 0 });
  });

  it("drains an SSE provider after the client closes and settles later usage", async () => {
    const { task, projectId, cookie } = await createTask("closed-client-sse");
    const encoder = new TextEncoder();
    providerResponseFactory = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n"));
        setTimeout(() => {
          controller.enqueue(encoder.encode("data: {\"usage\":{\"total_tokens\":6}}\n\ndata: [DONE]\n\n"));
          controller.close();
        }, 25);
      }
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/internal/tasks/${task.id}/runs/${task.runId}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer task-key:${task.id}:${task.runId}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ model: "gpt-compatible", messages: [{ role: "user", content: "stream" }], stream: true }),
      signal: controller.signal
    });
    await response.body?.getReader().read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 75));
    const { provider } = await fetch(`${baseUrl}/app/api/v1/projects/${projectId}/usage`, { headers: { cookie } }).then((result) => result.json());
    assert.deepEqual(provider.totals, { requests: 2, tokens: 6, cost: 0 });
  });

  it("returns a generic provider error without reflecting credential-like provider text", async () => {
    const { task } = await createTask("provider-error");
    providerResponseFactory = () => new Response("provider failure Bearer bsk_runtime_secret sk-provider-key", {
      status: 502,
      headers: { "content-type": "text/plain" }
    });
    const response = await fetch(`${baseUrl}/api/internal/tasks/${task.id}/runs/${task.runId}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer task-key:${task.id}:${task.runId}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-compatible", messages: [{ role: "user", content: "fail" }] })
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "OpenAI-compatible provider request failed" });
  });

  async function createTask(name: string) {
    await fetch(baseUrl + "/app/api/v1/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "broker-test-admin-password" })
    });
    const login = await fetch(baseUrl + "/app/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@agentsmith-lite.local", password: "broker-test-admin-password" })
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const loginBody = await login.json() as { csrfToken: string; user: { id: string } };
    const csrf = loginBody.csrfToken;
    const workspace = await post("/api/v1/workspaces", { name: `Workspace ${name}` }, cookie, csrf, `workspace-${name}`);
    const project = await post(`/api/v1/workspaces/${workspace.id}/projects`, { name: `Project ${name}` }, cookie, csrf, `project-${name}`);
    const credential = await post(`/api/v1/projects/${project.id}/credentials`, {
      name: "provider",
      baseUrl: "https://models.example.com/v1",
      secret: "sk-provider-key"
    }, cookie, csrf, `credential-${name}`);
    const brokerResponseFactory = providerResponseFactory;
    providerResponseFactory = () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    let endpoint: { id: string };
    try {
      endpoint = await post(`/api/v1/projects/${project.id}/endpoints`, {
        name: "provider",
        protocol: "openai_chat_completions",
        baseUrl: "https://models.example.com/v1",
        model: "gpt-compatible",
        credentialId: credential.id,
        capabilities: ["text", "tool_calls"],
        requestTimeoutSecs: 30
      }, cookie, csrf, `endpoint-${name}`);
    } finally {
      providerResponseFactory = brokerResponseFactory;
    }
    providerCalls.length = 0;
    const task = await post(`/api/v1/projects/${project.id}/tasks`, {
      prompt: "hello",
      endpointId: endpoint.id,
      fileLibrary: { mode: "create_new", name: `Task files ${name}` }
    }, cookie, csrf, `task-${name}`);
    const activeTask = await waitForActiveTask(task.task.id, cookie);
    return {
      task: activeTask,
      projectId: project.id,
      cookie,
      csrf,
      userId: loginBody.user.id
    };
  }

  async function waitForActiveTask(taskId: string, cookie: string): Promise<any> {
    const deadline = Date.now() + 2_000;
    let lastState: unknown;
    while (Date.now() < deadline) {
      const response = await fetch(`${baseUrl}/app/api/v1/tasks/${taskId}/detail`, { headers: { cookie } });
      assert.equal(response.status, 200);
      const detail = await response.json();
      lastState = detail.sandboxState;
      if (detail.sandboxState?.state === "active" && typeof detail.sandboxState.runId === "string") {
        return { ...detail.task, runId:detail.sandboxState.runId };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`Task ${taskId} was not dispatched to Botified: ${JSON.stringify(lastState)}`);
  }

  async function post(pathname: string, body: unknown, cookie: string, csrf: string, idempotencyKey: string): Promise<any> {
    const response = await fetch(baseUrl + "/app" + pathname, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf, "idempotency-key": idempotencyKey },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    return response.json();
  }
});

class AcceptingBotifiedClient implements BotifiedRuntimeHttpClient {
  readonly receipts = new Map<string, BotifiedDeliveryReceipt>();

  async health() { return { status: "ok" as const }; }
  async readState(_baseUrl: string, serviceKey: string) {
    const sessionId = serviceKey.split(":")[1];
    if (!sessionId) throw new Error("Test service key has no Task session");
    return { sessionId, snapshot: { session_id: sessionId }, state: "running" };
  }
  async postMessage(_baseUrl: string, _serviceKey: string, message: string): Promise<BotifiedPostMessageResult> {
    return { accepted: true, messageId: message, cursor: "cursor" };
  }
  async postMessageWithDelivery(_baseUrl: string, _serviceKey: string, input: BotifiedDeliveryMessageInput): Promise<BotifiedDeliveryReceipt> {
    const receipt: BotifiedDeliveryReceipt = { accepted: true, deliveryKey: input.deliveryKey, requestHash: input.requestHash, messageId: `message:${input.deliveryKey}`, cursor: `cursor:${input.deliveryKey}` };
    this.receipts.set(input.deliveryKey, receipt);
    return receipt;
  }
  async queryDeliveryReceipt(_baseUrl: string, _serviceKey: string, deliveryKey: string) {
    return this.receipts.get(deliveryKey) ?? null;
  }
  async readTimeline(_baseUrl: string, _serviceKey: string, cursor?: string): Promise<BotifiedTimelineReadResult> {
    return { status: "ok", events: [], ...(cursor ? { nextCursor: cursor } : {}) };
  }
  async uploadFile(_baseUrl: string, _serviceKey: string, _file: BotifiedUploadFileInput): Promise<BotifiedUploadFileResult> { return { files: [] }; }
  async downloadFile(_baseUrl: string, _serviceKey: string, fileId: string): Promise<BotifiedDownloadFileResult> { return { bytes: new Uint8Array(), sizeBytes: 0, filename: fileId }; }
  async abort(): Promise<BotifiedAbortResult> { return { aborted: true }; }
}

class ReadySandboxPort implements SandboxKubernetesMutationPort, SandboxKubernetesReadinessPort {
  private resources: KubernetesResource[] = [];

  async listManagedResources() { return structuredClone(this.resources); }
  async applyResource(resource: KubernetesResource) {
    this.resources = this.resources.filter((item) => item.kind !== resource.kind || item.metadata.name !== resource.metadata.name);
    this.resources.push(structuredClone(resource));
    return "applied" as const;
  }
  async deleteResource(ref: KubernetesResourceRef) {
    const before = this.resources.length;
    this.resources = this.resources.filter((item) => item.kind !== ref.kind || item.metadata.name !== ref.name);
    return before === this.resources.length ? "not_found" as const : "deleted" as const;
  }
  async getPodReadiness(): Promise<PodReadiness> { return "ready"; }
}
