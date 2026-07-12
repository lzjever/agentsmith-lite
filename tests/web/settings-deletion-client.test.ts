import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, apiClient } from "../../src/lib/api/client.js";

describe("settings deletion API client", () => {
  it("sends scoped delete requests with CSRF and preserves API error messages", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method: string; csrf: string | null }> = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://localhost"), init);
      requests.push({ url: request.url, method: request.method, csrf: request.headers.get("x-csrf-token") });
      if (request.url.endsWith("/me")) return Response.json({ user: { id: "owner_1", email: "owner@example.test" }, csrfToken: "csrf_1" });
      if (request.url.endsWith("/projects/project_1")) return Response.json({ error: "Project deletion is still pending" }, { status: 409 });
      return Response.json({ deleted: true });
    };
    try {
      await apiClient.currentIdentity();
      await assert.rejects(apiClient.deleteProject("project_1"), (error: unknown) => error instanceof ApiError && error.status === 409 && error.message === "Project deletion is still pending");
      await apiClient.deleteWorkspace("workspace_1");
      assert.deepEqual(requests.slice(1), [
        { url: "http://localhost/api/v1/projects/project_1", method: "DELETE", csrf: "csrf_1" },
        { url: "http://localhost/api/v1/workspaces/workspace_1", method: "DELETE", csrf: "csrf_1" }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
