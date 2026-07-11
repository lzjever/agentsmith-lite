import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApiServer } from "../../packages/api-entry-node/src/server.js";
import type { ChatMessage, ChatResponse, ModelEndpoint } from "../../packages/contracts/src/api.js";
import { MAX_PROJECT_FILE_BYTES } from "../../packages/domain/src/fileDefaults.js";
import type { ModelCredentialResolver, OpenAICompatibleClient } from "../../packages/openai-compatible-client/src/index.js";

describe("api product workflow", () => {
  let baseUrl = "";
  let closeServer: undefined | (() => Promise<void>);
  let dataRoot = "";
  const chatCalls: Array<{ endpoint: ModelEndpoint; messages: ChatMessage[]; apiKey: string }> = [];

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-api-"));
    const api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password",
      chatClient: fakeChatClient(chatCalls),
      modelCredentialResolver: fakeResolver({
        "secret/openai": {
          apiKey: "sk-from-api-workflow",
          baseUrl: "https://models.example.com/v1"
        }
      })
    });
    baseUrl = api.baseUrl;
    closeServer = api.close;
  });

  after(async () => {
    await closeServer?.();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("logs in and exercises workspace, project, endpoint, chat, file CRUD, and task resources", async () => {
    const health = await fetch(baseUrl + "/api/health").then((response) => response.json());
    assert.equal(health.status, "ok");

    await post("/api/auth/bootstrap", { password: "admin-password" });
    const login = await post("/api/auth/login", {
      email: "admin@agentsmith-lite.local",
      password: "admin-password"
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const csrf = (await login.json()).csrfToken;

    const workspace = await postJson("/api/workspaces", { name: "Ops" }, cookie, csrf);
    const project = await postJson(`/api/workspaces/${workspace.id}/projects`, { name: "Demo" }, cookie, csrf);
    const endpoint = await postJson(`/api/projects/${project.id}/endpoints`, {
      name: "OpenAI-compatible endpoint",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.com/v1",
      model: "gpt-compatible",
      apiKeySecretRef: "secret/openai",
      capabilities: ["text", "tool_calls"],
      requestTimeoutSecs: 30
    }, cookie, csrf);
    assertNoApiKeySecretRef(endpoint);
    assert.equal(endpoint.hasCredentialRef, true);
    assert.equal(endpoint.apiKeySecretRef, undefined);

    const endpoints = await requestJson("GET", `/api/projects/${project.id}/endpoints`, undefined, cookie);
    assertNoApiKeySecretRef(endpoints);
    assert.equal(endpoints[0]?.hasCredentialRef, true);

    const chat = await postJson(`/api/projects/${project.id}/chat`, {
      endpointId: endpoint.id,
      messages: [{ role: "user", content: "hello" }]
    }, cookie, csrf);
    const filePath = "files/docs/readme.md";
    const fileContent = Uint8Array.from([0x00, 0xff, 0x41, 0x0a]);
    const uploadedFile = await requestRawFile(project.id, filePath, fileContent, cookie, csrf);
    const listedRootFiles = await requestJson("GET", `/api/projects/${project.id}/files?path=files`, undefined, cookie);
    const listedNestedFiles = await requestJson("GET", `/api/projects/${project.id}/files?path=${encodeURIComponent("files/docs")}`, undefined, cookie);
    const downloadedFile = await request(
      "GET",
      `/api/projects/${project.id}/files/download?path=${encodeURIComponent(filePath)}`,
      undefined,
      cookie
    );
    const unicodeFilePath = "files/docs/报告.md";
    const unicodeFileContent = Uint8Array.from([0x75, 0x6e, 0x69, 0x63, 0x6f, 0x64, 0x65]);
    await requestRawFile(project.id, unicodeFilePath, unicodeFileContent, cookie, csrf);
    const downloadedUnicodeFile = await request(
      "GET",
      `/api/projects/${project.id}/files/download?path=${encodeURIComponent(unicodeFilePath)}`,
      undefined,
      cookie
    );
    await assertApiError(
      await request("GET", `/api/projects/${project.id}/files/download`, undefined, cookie),
      400,
      "Missing path query parameter"
    );
    await assertApiError(
      await request(
        "GET",
        `/api/projects/${project.id}/files/download?path=${encodeURIComponent("files/docs")}`,
        undefined,
        cookie
      ),
      400,
      "Path is a directory"
    );
    await assertApiError(
      await request("DELETE", `/api/projects/${project.id}/files`, { path: "files" }, cookie, csrf),
      400,
      "Cannot delete the files root"
    );
    await assertApiError(
      await request("DELETE", `/api/projects/${project.id}/files`, { path: "files/missing.txt" }, cookie, csrf),
      404,
      "File not found"
    );
    const deletedFile = await requestJson("DELETE", `/api/projects/${project.id}/files`, {
      path: filePath
    }, cookie, csrf);
    const task = await postJson(`/api/projects/${project.id}/tasks`, {
      prompt: "write a file",
      endpointId: endpoint.id
    }, cookie, csrf);
    const dashboard = await requestJson("GET", "/api/dashboard", undefined, cookie);

    assertNoApiKeySecretRef(dashboard);
    assert.equal(dashboard.endpoints[0]?.hasCredentialRef, true);
    assert.equal(chat.message.content, "server-side fake chat response");
    assert.equal(chatCalls.length, 1);
    assert.equal(chatCalls[0]?.endpoint.id, endpoint.id);
    assert.deepEqual(chatCalls[0]?.messages, [{ role: "user", content: "hello" }]);
    assert.equal(chatCalls[0]?.apiKey, "sk-from-api-workflow");
    assert.deepEqual(chat.endpointSnapshot, {
      id: endpoint.id,
      baseUrl: "https://models.example.com/v1",
      model: "gpt-compatible",
      protocol: "openai_chat_completions"
    });
    assert.deepEqual(uploadedFile, { path: filePath, bytes: fileContent.byteLength });
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
    assert.equal(task.status, "running");
    assert.equal(task.sandbox.resources.some((resource: { kind: string }) => resource.kind === "Pod"), true);

    const traversal = await fetch(baseUrl + `/api/projects/${project.id}/files?path=${encodeURIComponent("../secret.txt")}`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        cookie,
        "x-csrf-token": csrf
      },
      body: Buffer.from([0x6e, 0x6f, 0x70, 0x65])
    });
    assert.equal(traversal.status, 400);

    const unauthenticatedUpload = await fetch(baseUrl + `/api/projects/${project.id}/files?path=files/forbidden.bin`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from([0x01])
    });
    assert.equal(unauthenticatedUpload.status, 401);

    const tooLargeUpload = await rawRequest(
      `/api/projects/${project.id}/files?path=files/too-large.bin`,
      cookie,
      csrf,
      { "content-length": String(MAX_PROJECT_FILE_BYTES + 1) }
    );
    assert.equal(tooLargeUpload.status, 413);
    assert.deepEqual(tooLargeUpload.body, { error: `Project file exceeds the ${MAX_PROJECT_FILE_BYTES}-byte limit` });

    const forbidden = await fetch(baseUrl + `/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Missing CSRF" })
    });
    assert.equal(forbidden.status, 403);
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
    const requestInit: RequestInit = { method, headers };
    if (body) {
      requestInit.body = JSON.stringify(body);
    }
    return fetch(baseUrl + pathname, requestInit);
  }

  async function requestRawFile(projectId: string, filePath: string, bytes: Uint8Array, cookie: string, csrf: string) {
    const response = await fetch(baseUrl + `/api/projects/${projectId}/files?path=${encodeURIComponent(filePath)}`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        cookie,
        "x-csrf-token": csrf
      },
      body: Buffer.from(bytes)
    });
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    return response.json();
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

function fakeResolver(values: Record<string, { apiKey: string; baseUrl: string }>): ModelCredentialResolver {
  return {
    resolveCredential(secretRef: string): { apiKey: string; baseUrl: string } {
      const value = values[secretRef];
      assert.ok(value, `missing fake secret for ${secretRef}`);
      return value;
    }
  };
}

function assertNoApiKeySecretRef(value: unknown): void {
  assert.doesNotMatch(JSON.stringify(value), /apiKeySecretRef/);
}
