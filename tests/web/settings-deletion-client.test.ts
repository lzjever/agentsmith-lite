import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, apiClient, IdempotencyPendingError, SESSION_EXPIRED_EVENT } from "../../src/lib/api/client.js";

describe("settings deletion API client", () => {
  it("sends explicit idempotency keys for workspace and project creation", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; idempotencyKey: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://localhost"), init);
      requests.push({ url: request.url, idempotencyKey: request.headers.get("idempotency-key") });
      if (request.url.endsWith("/me")) return Response.json({ user: { id: "owner_1", email: "owner@example.test" }, csrfToken: "csrf_1" });
      if (request.url.endsWith("/workspaces")) return Response.json({ id: "workspace_1" });
      return Response.json({ id: "project_1" });
    };
    try {
      await apiClient.currentIdentity();
      await apiClient.createWorkspace("Workspace", "workspace-create-key");
      await apiClient.createProject("workspace_1", { name: "Project" }, "project-create-key");
      assert.deepEqual(requests.slice(1), [
        { url: "http://localhost/api/v1/workspaces", idempotencyKey: "workspace-create-key" },
        { url: "http://localhost/api/v1/workspaces/workspace_1/projects", idempotencyKey: "project-create-key" }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends explicit idempotency keys for credential and endpoint creation", async () => {
    const originalFetch = globalThis.fetch;
    const keys: Array<string | null> = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://localhost"), init);
      keys.push(request.headers.get("idempotency-key"));
      return Response.json({ id: "created" });
    };
    try {
      await apiClient.createCredential("project_1", { name: "Provider", baseUrl: "https://models.example.test/v1", secret: "secret" }, "credential-key");
      await apiClient.createEndpoint("project_1", { name: "Provider", baseUrl: "https://models.example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text"], requestTimeoutSecs: 30 }, "endpoint-key");
      assert.deepEqual(keys, ["credential-key", "endpoint-key"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends an explicit idempotency key for chat thread creation", async () => {
    const originalFetch = globalThis.fetch;
    let key: string | null = null;
    globalThis.fetch = async (input, init) => {
      const request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://localhost"), init);
      key = request.headers.get("idempotency-key");
      return Response.json({ id: "chat_1" });
    };
    try {
      await apiClient.createChatThread("project_1", "endpoint_1", "chat-thread-key");
      assert.equal(key, "chat-thread-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends scoped delete requests with CSRF and preserves API error messages", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method: string; csrf: string | null; idempotencyKey: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://localhost"), init);
      requests.push({ url: request.url, method: request.method, csrf: request.headers.get("x-csrf-token"), idempotencyKey: request.headers.get("idempotency-key") });
      if (request.url.endsWith("/me")) return Response.json({ user: { id: "owner_1", email: "owner@example.test" }, csrfToken: "csrf_1" });
      if (request.url.endsWith("/projects/project_1")) return Response.json({ error: "Project deletion is still pending" }, { status: 409 });
      return Response.json({ deleted: true });
    };
    try {
      await apiClient.currentIdentity();
      await assert.rejects(apiClient.deleteProject("project_1", "project-delete-key"), (error: unknown) => error instanceof ApiError && error.status === 409 && error.message === "Project deletion is still pending");
      await apiClient.deleteWorkspace("workspace_1", "workspace-delete-key");
      assert.deepEqual(requests.slice(1), [
        { url: "http://localhost/api/v1/projects/project_1", method: "DELETE", csrf: "csrf_1", idempotencyKey: "project-delete-key" },
        { url: "http://localhost/api/v1/workspaces/workspace_1", method: "DELETE", csrf: "csrf_1", idempotencyKey: "workspace-delete-key" }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("extracts the message from structured API errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ error: { code: "runtime_unavailable", message: "Runtime is temporarily unavailable.", retryable: true } }, { status: 503 });
    try {
      await assert.rejects(apiClient.projectSettings("project_1"), (error: unknown) => error instanceof ApiError && error.status === 503 && error.message === "Runtime is temporarily unavailable.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps in-progress idempotent responses distinct from final API errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ error: "Idempotent operation is still in progress", code: "idempotency_in_progress" }, { status: 409 });
    try {
      await assert.rejects(
        apiClient.deleteProject("project_1", "project-delete-key"),
        (error: unknown) => error instanceof IdempotencyPendingError && !(error instanceof ApiError) && error.message === "Idempotent operation is still in progress"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("notifies the shell when an API request finds an expired session", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const browserEvents = new EventTarget();
    let expirations = 0;
    browserEvents.addEventListener(SESSION_EXPIRED_EVENT, () => { expirations += 1; });
    Object.defineProperty(globalThis, "window", { configurable: true, value: browserEvents });
    globalThis.fetch = async () => Response.json({ error: "Unauthorized" }, { status: 401 });
    try {
      await assert.rejects(apiClient.workspaces(), (error: unknown) => error instanceof ApiError && error.status === 401);
      await assert.rejects(apiClient.previewLibraryFile("project_1", "library_1", "input.txt"), (error: unknown) => error instanceof ApiError && error.status === 401);
      assert.equal(expirations, 2);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });
});
