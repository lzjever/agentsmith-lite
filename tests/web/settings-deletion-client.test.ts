import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, apiClient, SESSION_EXPIRED_EVENT } from "../../src/lib/api/client.js";

describe("settings deletion API client", () => {
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
      await assert.rejects(apiClient.downloadProjectFile("project_1", "files/input.txt"), (error: unknown) => error instanceof ApiError && error.status === 401);
      assert.equal(expirations, 2);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  });
});
