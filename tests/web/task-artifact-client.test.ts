import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTaskArtifact } from "../../packages/contracts/src/api.js";
import { apiClient, taskArtifactDownloadUrlForApiBase } from "../../src/lib/api/client.js";

describe("task artifact download client", () => {
  it("builds an encoded download URL with the application base path exactly once", () => {
    assert.equal(
      taskArtifactDownloadUrlForApiBase("/app/api/v1", "task/with spaces", "artifact?#1"),
      "/app/api/v1/tasks/task%2Fwith%20spaces/artifacts/artifact%3F%231/download"
    );
  });

  it("downloads a task artifact from its authorized API route with same-origin credentials", async () => {
    const original = globalThis.fetch;
    let request: Request | undefined;
    globalThis.fetch = async (input, init) => {
      request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://localhost"), init);
      return new Response(Uint8Array.of(137, 80, 78, 71), { headers: { "content-type": "image/png" } });
    };
    try {
      const blob = await apiClient.downloadTaskArtifact("task/1", "artifact 1");
      assert.equal(request?.url, "http://localhost/api/v1/tasks/task%2F1/artifacts/artifact%201/download");
      assert.equal(request?.credentials, "same-origin");
      assert.equal(blob.type, "image/png");
    } finally { globalThis.fetch = original; }
  });

  it("encodes Artifact page filters and returns the paged response", async () => {
    const original = globalThis.fetch;
    let request: Request | undefined;
    const artifact: AgentTaskArtifact = {
      id: "artifact_1",
      taskId: "task/1",
      name: "result.txt",
      bytes: 6,
      mediaType: "text/plain",
      previewText: "result",
      createdAt: "2026-07-24T00:00:00.000Z"
    };
    globalThis.fetch = async (input, init) => {
      request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, "http://localhost"), init);
      return Response.json({ items: [artifact], nextCursor: "next-page" });
    };
    try {
      const page = await apiClient.taskArtifacts("task/1", {
        cursor: "cursor value",
        kind: "text",
        limit: 20,
        mediaType: "text/plain",
        previewOnly: true
      });
      const url = new URL(request!.url);

      assert.equal(url.pathname, "/api/v1/tasks/task%2F1/artifacts");
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        cursor: "cursor value",
        kind: "text",
        limit: "20",
        mediaType: "text/plain",
        preview: "true"
      });
      assert.equal(request?.credentials, "same-origin");
      assert.deepEqual(page, { items: [artifact], nextCursor: "next-page" });
    } finally { globalThis.fetch = original; }
  });
});
