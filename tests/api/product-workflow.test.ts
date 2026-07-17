import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createTestApiServer as createApiServer } from "../../packages/api-entry-node/src/server.js";
import type { ChatMessage, ChatResponse, ModelEndpoint } from "../../packages/contracts/src/api.js";
import { MAX_PROJECT_FILE_BYTES } from "../../packages/domain/src/fileDefaults.js";
import type { OpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";

describe("api product workflow", () => {
  let baseUrl = "";
  let closeServer: undefined | (() => Promise<void>);
  let dataRoot = "";
  let idempotencySequence = 0;
  const chatCalls: Array<{ endpoint: ModelEndpoint; messages: ChatMessage[]; apiKey: string }> = [];

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-api-"));
    const api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password",
      providerClient: fakeChatClient(chatCalls),
    });
    baseUrl = api.baseUrl;
    closeServer = api.close;
  });

  after(async () => {
    await closeServer?.();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("logs in and exercises workspace, project, endpoint, chat, file CRUD, and task resources", async () => {
    const health = await fetch(baseUrl + "/api/v1/health").then((response) => response.json());
    assert.equal(health.status, "ok");

    await post("/api/v1/auth/bootstrap", { password: "admin-password" });
    const login = await post("/api/v1/auth/login", {
      email: "admin@agentsmith-lite.local",
      password: "admin-password"
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const csrf = (await login.json()).csrfToken;

    const workspace = await postJson("/api/v1/workspaces", { name: "Ops" }, cookie, csrf);
    const project = await postJson(`/api/v1/workspaces/${workspace.id}/projects`, { name: "Demo" }, cookie, csrf);
    const emptyOverview = await requestJson("GET", `/api/v1/projects/${project.id}/overview`, undefined, cookie);
    assert.deepEqual(emptyOverview.recommendedActions, ["configure_endpoint", "add_collaborator"]);
    const pinnedProject = await requestJson("PUT", `/api/v1/projects/${project.id}/pin`, { pinned: true }, cookie, csrf);
    assert.ok(pinnedProject.pinnedAt);
    const pinnedWorkspace = (await requestJson("GET", "/api/v1/workspaces", undefined, cookie))[0];
    assert.equal(pinnedWorkspace.projects.find((item: { id: string }) => item.id === project.id)?.pinnedAt, pinnedProject.pinnedAt);
    assert.equal((await requestJson("PUT", `/api/v1/projects/${project.id}/pin`, { pinned: false }, cookie, csrf)).pinnedAt, null);
    const credential = await postJson(`/api/v1/projects/${project.id}/credentials`, { name: "OpenAI-compatible credential", baseUrl: "https://models.example.com/v1", secret: "sk-from-api-workflow" }, cookie, csrf);
    const endpoint = await postJson(`/api/v1/projects/${project.id}/endpoints`, {
      name: "OpenAI-compatible endpoint",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.com/v1",
      model: "gpt-compatible",
      credentialId: credential.id,
      capabilities: ["text", "tool_calls"],
      requestTimeoutSecs: 30
    }, cookie, csrf);
    assertNoApiKeySecretRef(endpoint);
    assert.equal(endpoint.hasCredentialRef, true);
    assert.equal(endpoint.credentialId, credential.id);
    const readyOverview = await requestJson("GET", `/api/v1/projects/${project.id}/overview`, undefined, cookie);
    assert.deepEqual(readyOverview.recommendedActions, ["start_chat", "create_task", "add_collaborator"]);
    assert.equal(readyOverview.taskReadyEndpointCount, 1);

    const endpoints = await requestJson("GET", `/api/v1/projects/${project.id}/endpoints`, undefined, cookie);
    assertNoApiKeySecretRef(endpoints);
    assert.equal(endpoints[0]?.hasCredentialRef, true);
    assert.equal(endpoints[0]?.credentialId, credential.id);
    const updatedEndpoint = await requestJson("PATCH", `/api/v1/projects/${project.id}/endpoints/${endpoint.id}`, {
      name: "Updated endpoint",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.com/v1",
      model: "updated-compatible",
      capabilities: ["text", "tool_calls"],
      requestTimeoutSecs: 45
    }, cookie, csrf);
    assert.equal(updatedEndpoint.name, "Updated endpoint");
    assert.equal(updatedEndpoint.model, "updated-compatible");
    assert.equal(updatedEndpoint.credentialId, credential.id);
    assert.equal(updatedEndpoint.hasCredentialRef, true);
    const disposableEndpoint = await postJson(`/api/v1/projects/${project.id}/endpoints`, {
      name: "Disposable endpoint",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.com/v1",
      model: "gpt-compatible",
      credentialId: credential.id,
      capabilities: ["text", "tool_calls"],
      requestTimeoutSecs: 30
    }, cookie, csrf);
    const replacementCredential = await postJson(`/api/v1/projects/${project.id}/credentials`, { name: "Replacement credential", baseUrl: "https://models.example.com/v1", secret: "replacement-api-secret" }, cookie, csrf);
    const reboundEndpoint = await requestJson("PATCH", `/api/v1/projects/${project.id}/endpoints/${disposableEndpoint.id}`, {
      name: disposableEndpoint.name,
      protocol: disposableEndpoint.protocol,
      baseUrl: disposableEndpoint.baseUrl,
      model: disposableEndpoint.model,
      credentialId: replacementCredential.id,
      capabilities: disposableEndpoint.capabilities,
      requestTimeoutSecs: disposableEndpoint.requestTimeoutSecs
    }, cookie, csrf);
    assert.equal(reboundEndpoint.credentialId, replacementCredential.id);
    assertNoApiKeySecretRef(reboundEndpoint);
    const disposableThread = await postJson(`/api/v1/projects/${project.id}/chat/threads`, { endpointId: disposableEndpoint.id }, cookie, csrf);
    assert.deepEqual(
      await requestJson("DELETE", `/api/v1/projects/${project.id}/endpoints/${disposableEndpoint.id}`, undefined, cookie, csrf),
      { deleted: true }
    );
    const retainedThreads = await requestJson("GET", `/api/v1/projects/${project.id}/chat/threads`, undefined, cookie);
    assert.equal(retainedThreads.find((item: { id: string }) => item.id === disposableThread.id)?.endpointId, null);

    const thread = await postJson(`/api/v1/projects/${project.id}/chat/threads`, { endpointId: endpoint.id }, cookie, csrf);
    const chat = await postChatStream(`/api/v1/projects/${project.id}/chat/threads/${thread.id}/messages`, { content: "hello", afterMessageId: null }, cookie, csrf);
    const chatHistory = await requestJson("GET", `/api/v1/projects/${project.id}/chat/threads/${thread.id}/messages`, undefined, cookie);
    const filePath = "files/docs/readme.md";
    const fileContent = Uint8Array.from([0x00, 0xff, 0x41, 0x0a]);
    const uploadedFile = await requestRawFile(project.id, filePath, fileContent, cookie, csrf);
    await assertApiError(
      await requestRawFileResponse(project.id, filePath, Buffer.from("unconfirmed replacement"), cookie, csrf),
      409,
      "Project file already exists"
    );
    await requestRawFile(project.id, filePath, fileContent, cookie, csrf, "application/octet-stream", true);
    const listedRootFiles = await requestJson("GET", `/api/v1/projects/${project.id}/files?path=files`, undefined, cookie);
    const listedNestedFiles = await requestJson("GET", `/api/v1/projects/${project.id}/files?path=${encodeURIComponent("files/docs")}`, undefined, cookie);
    const downloadedFile = await request(
      "GET",
      `/api/v1/projects/${project.id}/files/download?path=${encodeURIComponent(filePath)}`,
      undefined,
      cookie
    );
    const unicodeFilePath = "files/docs/报告.md";
    const unicodeFileContent = Uint8Array.from([0x75, 0x6e, 0x69, 0x63, 0x6f, 0x64, 0x65]);
    await requestRawFile(project.id, unicodeFilePath, unicodeFileContent, cookie, csrf);
    const downloadedUnicodeFile = await request(
      "GET",
      `/api/v1/projects/${project.id}/files/download?path=${encodeURIComponent(unicodeFilePath)}`,
      undefined,
      cookie
    );
    await assertApiError(
      await request("GET", `/api/v1/projects/${project.id}/files/download`, undefined, cookie),
      400,
      "Missing path query parameter"
    );
    await assertApiError(
      await request(
        "GET",
        `/api/v1/projects/${project.id}/files/download?path=${encodeURIComponent("files/docs")}`,
        undefined,
        cookie
      ),
      400,
      "Path is a directory"
    );
    await assertApiError(
      await request("DELETE", `/api/v1/projects/${project.id}/files`, { path: "files" }, cookie, csrf),
      400,
      "Cannot delete the files root"
    );
    assert.equal((await requestJson("GET", `/api/v1/projects/${project.id}/files?path=files`, undefined, cookie)).entries.length, 1);
    await assertApiError(
      await request("DELETE", `/api/v1/projects/${project.id}/files`, { path: "files/missing.txt" }, cookie, csrf),
      404,
      "File not found"
    );
    const deletedFile = await requestJson("DELETE", `/api/v1/projects/${project.id}/files`, {
      path: filePath
    }, cookie, csrf);
    const task = await postJson(`/api/v1/projects/${project.id}/tasks`, {
      prompt: "write a file",
      endpointId: endpoint.id
    }, cookie, csrf);
    const dashboard = await requestJson("GET", "/api/v1/dashboard", undefined, cookie);

    assertNoApiKeySecretRef(dashboard);
    assert.equal(dashboard.endpoints[0]?.hasCredentialRef, true);
    assert.equal(dashboard.endpoints[0]?.credentialId, credential.id);
    assert.equal(chat.message.content, "server-side fake chat response");
    assert.deepEqual(chatHistory.map((message: { role: string; content: string }) => [message.role, message.content]), [["user", "hello"], ["assistant", "server-side fake chat response"]]);
    assert.equal(chatCalls.length, 1);
    assert.equal(chatCalls[0]?.endpoint.id, endpoint.id);
    assert.deepEqual(chatCalls[0]?.messages, [{ role: "user", content: "hello" }]);
    assert.equal(chatCalls[0]?.apiKey, "sk-from-api-workflow");
    assert.deepEqual(chat.endpointSnapshot, {
      id: endpoint.id,
      baseUrl: "https://models.example.com/v1",
      model: "updated-compatible",
      protocol: "openai_chat_completions"
    });
    const { updatedAt: uploadedAt, ...uploadedFileDetails } = uploadedFile;
    assert.deepEqual(uploadedFileDetails, { path: filePath, bytes: fileContent.byteLength, mediaType: "application/octet-stream" });
    assert.equal(Number.isNaN(Date.parse(uploadedAt)), false);
    assert.equal(listedRootFiles.entries.some((entry: { name: string; path: string; type: string }) =>
      entry.path === "files/docs" && entry.name === "docs" && entry.type === "directory"
    ), true);
    assert.equal(listedNestedFiles.entries.some((entry: { name: string; path: string; type: string }) =>
      entry.name === "readme.md" && entry.path === filePath && entry.type === "file"
    ), true);
    assert.equal(downloadedFile.status, 200);
    assert.equal(downloadedFile.headers.get("content-type"), "application/octet-stream");
    assert.equal(downloadedFile.headers.get("content-length"), String(fileContent.byteLength));
    assert.equal(downloadedFile.headers.get("content-disposition"), "attachment; filename=\"readme.md\"");
    assert.equal(downloadedFile.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(new Uint8Array(await downloadedFile.arrayBuffer()), fileContent);
    assert.equal(downloadedUnicodeFile.status, 200);
    assert.equal(
      downloadedUnicodeFile.headers.get("content-disposition"),
      "attachment; filename=\"__.md\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.md"
    );
    assert.deepEqual(new Uint8Array(await downloadedUnicodeFile.arrayBuffer()), unicodeFileContent);
    assert.deepEqual(deletedFile, { deleted: true });
    assert.equal(task.status, "completed");
    assert.equal(task.terminalReason, "not_executed");
    assert.deepEqual(task.sandbox.resources, []);

    await assertApiError(
      await request("DELETE", `/api/v1/projects/${project.id}/endpoints/${endpoint.id}`, undefined, cookie, csrf),
      409,
      "Endpoint cannot be deleted while tasks reference it"
    );
    const threadAfterBlockedDelete = (await requestJson("GET", `/api/v1/projects/${project.id}/chat/threads`, undefined, cookie))
      .find((item: { id: string }) => item.id === thread.id);
    assert.equal(threadAfterBlockedDelete?.endpointId, endpoint.id);

    const traversal = await fetch(baseUrl + `/api/v1/projects/${project.id}/files?path=${encodeURIComponent("../secret.txt")}`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        cookie,
        "x-csrf-token": csrf
      },
      body: Buffer.from([0x6e, 0x6f, 0x70, 0x65])
    });
    assert.equal(traversal.status, 400);

    const unauthenticatedUpload = await fetch(baseUrl + `/api/v1/projects/${project.id}/files?path=files/forbidden.bin`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from([0x01])
    });
    assert.equal(unauthenticatedUpload.status, 401);

    const tooLargeUpload = await rawRequest(
      `/api/v1/projects/${project.id}/files?path=files/too-large.bin`,
      cookie,
      csrf,
      { "content-length": String(MAX_PROJECT_FILE_BYTES + 1) }
    );
    assert.equal(tooLargeUpload.status, 413);
    assert.deepEqual(tooLargeUpload.body, { error: `Project file exceeds the ${MAX_PROJECT_FILE_BYTES}-byte limit` });

    const forbidden = await fetch(baseUrl + `/api/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Missing CSRF" })
    });
    assert.equal(forbidden.status, 403);
  });

  it("stores browser file MIME types as raw bytes", async () => {
    await post("/api/v1/auth/bootstrap", { password: "admin-password" });
    const login = await post("/api/v1/auth/login", {
      email: "admin@agentsmith-lite.local",
      password: "admin-password"
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const csrf = (await login.json()).csrfToken;
    const workspace = await postJson("/api/v1/workspaces", { name: "Upload MIME types" }, cookie, csrf);
    const project = await postJson(`/api/v1/workspaces/${workspace.id}/projects`, { name: "Browser files" }, cookie, csrf);
    const uploads = [
      { path: "files/note.txt", contentType: "text/plain;charset=UTF-8", bytes: Uint8Array.from([0x7b, 0x22, 0x6e, 0x6f, 0x74, 0x65, 0x22, 0x7d]) },
      { path: "files/image.png", contentType: "image/png", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
      { path: "files/data.bin", contentType: "application/octet-stream", bytes: Uint8Array.from([0x00, 0xff, 0x41]) }
    ];

    for (const upload of uploads) {
      const { updatedAt, ...written } = await requestRawFile(project.id, upload.path, upload.bytes, cookie, csrf, upload.contentType);
      assert.deepEqual(written, { path: upload.path, bytes: upload.bytes.byteLength, mediaType: upload.contentType.split(";", 1)[0] });
      assert.equal(Number.isNaN(Date.parse(updatedAt)), false);
      const downloaded = await request(
        "GET",
        `/api/v1/projects/${project.id}/files/download?path=${encodeURIComponent(upload.path)}`,
        undefined,
        cookie
      );
      assert.equal(downloaded.status, 200);
      assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), upload.bytes);
    }
  });

  async function post(pathname: string, body: unknown) {
    return fetch(baseUrl + pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  async function postJson(pathname: string, body: unknown, cookie: string, csrf: string) {
    return requestJson("POST", pathname, body, cookie, csrf);
  }

  async function postChatStream(pathname: string, body: unknown, cookie: string, csrf: string) {
    const response = await request("POST", pathname, body, cookie, csrf);
    assert.equal(response.status, 200);
    const frame = (await response.text()).split("\n\n").find((value) => value.startsWith("event: done"));
    const data = frame ? /^data: (.+)$/m.exec(frame)?.[1] : undefined;
    assert.ok(data);
    return JSON.parse(data);
  }

  async function requestJson(method: string, pathname: string, body: unknown, cookie: string, csrf?: string) {
    const response = await request(method, pathname, body, cookie, csrf);
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    return response.json();
  }

  async function request(method: string, pathname: string, body: unknown, cookie: string, csrf?: string) {
    const headers: Record<string, string> = { "content-type": "application/json", cookie };
    if (csrf) {
      headers["x-csrf-token"] = csrf;
    }
    if (pathname.includes("/tasks") && ["POST","PATCH","DELETE"].includes(method)) {
      headers["idempotency-key"] = `workflow-${++idempotencySequence}`;
    }
    if (method === "POST" && (pathname === "/api/v1/workspaces" || /^\/api\/v1\/workspaces\/[^/]+\/projects$/.test(pathname))) {
      headers["idempotency-key"] = crypto.randomUUID();
    }
    const requestInit: RequestInit = { method, headers };
    if (body) {
      requestInit.body = JSON.stringify(body);
    }
    return fetch(baseUrl + pathname, requestInit);
  }

  async function requestRawFile(
    projectId: string,
    filePath: string,
    bytes: Uint8Array,
    cookie: string,
    csrf: string,
    contentType = "application/octet-stream",
    overwrite = false
  ) {
    const response = await requestRawFileResponse(projectId, filePath, bytes, cookie, csrf, contentType, overwrite);
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    return response.json();
  }

  async function requestRawFileResponse(projectId: string, filePath: string, bytes: Uint8Array, cookie: string, csrf: string, contentType = "application/octet-stream", overwrite = false) {
    const query = new URLSearchParams({ path: filePath, ...(overwrite ? { overwrite: "true" } : {}) });
    return fetch(baseUrl + `/api/v1/projects/${projectId}/files?${query}`, {
      method: "PUT",
      headers: {
        "content-type": contentType,
        cookie,
        "x-csrf-token": csrf
      },
      body: Buffer.from(bytes)
    });
  }

  async function rawRequest(pathname: string, cookie: string, csrf: string, headers: Record<string, string>) {
    const url = new URL(baseUrl + pathname);
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = httpRequest({
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          cookie,
          "x-csrf-token": csrf,
          ...headers
        }
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
        }));
      });
      request.on("error", reject);
      request.end();
    });
  }

  async function assertApiError(response: Response, status: number, error: string) {
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
});

function fakeChatClient(calls: Array<{ endpoint: ModelEndpoint; messages: ChatMessage[]; apiKey: string }>): OpenAICompatibleClient {
  return {
    async validateEndpoint() {
      return { status: "healthy" };
    },
    async completeChat(endpoint, messages, options): Promise<ChatResponse> {
      calls.push({ endpoint, messages, apiKey: options.apiKey });
      return {
        message: { role: "assistant", content: "server-side fake chat response" },
        endpointSnapshot: {
          id: endpoint.id,
          baseUrl: endpoint.baseUrl,
          model: endpoint.model,
          protocol: endpoint.protocol
        }
      };
    }
  };
}

function fakeResolver(values: Record<string, { apiKey: string; baseUrl: string }>) {
  return {
    resolveCredential(secretRef: string): { apiKey: string; baseUrl: string } {
      const value = values[secretRef];
      assert.ok(value, `missing fake secret for ${secretRef}`);
      return value;
    }
  };
}

function assertNoApiKeySecretRef(value: unknown): void {
  assert.doesNotMatch(JSON.stringify(value), /sk-from-api-workflow|replacement-api-secret|apiKeySecretRef|api_key_secret_ref|ciphertext|authTag|nonce|keyId/);
}
