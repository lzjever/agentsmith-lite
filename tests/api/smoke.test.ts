import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApiServer } from "../../packages/api-entry-node/src/server.js";

describe("api smoke", () => {
  let baseUrl = "";
  let closeServer: undefined | (() => Promise<void>);
  let dataRoot = "";

  before(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), "asl-api-"));
    const api = await createApiServer({
      port: 0,
      dataRoot,
      builtinAdminPassword: "admin-password"
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
      name: "Mock endpoint",
      protocol: "openai_chat_completions",
      baseUrl: "https://models.example.com/v1",
      model: "gpt-compatible",
      apiKeySecretRef: "secret/mock",
      capabilities: ["text"],
      requestTimeoutSecs: 30
    }, cookie, csrf);
    const chat = await postJson(`/api/projects/${project.id}/chat`, {
      endpointId: endpoint.id,
      messages: [{ role: "user", content: "hello" }]
    }, cookie, csrf);
    const fileValidation = await postJson(`/api/projects/${project.id}/files/validate`, {
      path: "files/readme.md"
    }, cookie, csrf);
    const uploadedFile = await requestJson("POST", `/api/projects/${project.id}/files`, {
      path: "files/readme.md",
      content: "hello from API smoke"
    }, cookie, csrf);
    const listedFiles = await requestJson("GET", `/api/projects/${project.id}/files?path=files`, undefined, cookie);
    const downloadedFile = await requestJson(
      "GET",
      `/api/projects/${project.id}/files/download?path=${encodeURIComponent("files/readme.md")}`,
      undefined,
      cookie
    );
    const deletedFile = await requestJson("DELETE", `/api/projects/${project.id}/files`, {
      path: "files/readme.md"
    }, cookie, csrf);
    const task = await postJson(`/api/projects/${project.id}/tasks`, {
      prompt: "write a file",
      endpointId: endpoint.id
    }, cookie, csrf);

    assert.match(chat.message.content, /mock openai-compatible response/i);
    assert.equal(fileValidation.normalizedPath, "files/readme.md");
    assert.deepEqual(uploadedFile, { path: "files/readme.md", bytes: 20 });
    assert.equal(listedFiles.entries.some((entry: { path: string }) => entry.path === "files/readme.md"), true);
    assert.deepEqual(downloadedFile, { path: "files/readme.md", content: "hello from API smoke" });
    assert.deepEqual(deletedFile, { deleted: true });
    assert.equal(task.status, "running");
    assert.equal(task.sandbox.resources.some((resource: { kind: string }) => resource.kind === "Pod"), true);

    const traversal = await fetch(baseUrl + `/api/projects/${project.id}/files`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf
      },
      body: JSON.stringify({ path: "../secret.txt", content: "nope" })
    });
    assert.equal(traversal.status, 400);

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
    const headers: Record<string, string> = { "content-type": "application/json", cookie };
    if (csrf) {
      headers["x-csrf-token"] = csrf;
    }
    const requestInit: RequestInit = { method, headers };
    if (body) {
      requestInit.body = JSON.stringify(body);
    }
    const response = await fetch(baseUrl + pathname, requestInit);
    if (response.status !== 200) {
      assert.fail(await response.text());
    }
    return response.json();
  }
});
