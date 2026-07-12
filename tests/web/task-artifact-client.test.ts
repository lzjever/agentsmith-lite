import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apiClient } from "../../src/lib/api/client.js";

describe("task artifact download client", () => {
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
});
