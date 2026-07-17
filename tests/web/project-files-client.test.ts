import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apiClient } from "../../src/lib/api/client.js";

describe("project files API client", () => {
  it("uses the project API for list, binary upload, download, and delete", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method: string; contentType: string | null; csrf: string | null; idempotencyKey: string | null; body: BodyInit | null | undefined }> = [];
    globalThis.fetch = async (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const request = new Request(new URL(rawUrl, "http://localhost"), init);
      requests.push({ url: request.url, method: request.method, contentType: request.headers.get("content-type"), csrf: request.headers.get("x-csrf-token"), idempotencyKey: request.headers.get("idempotency-key"), body: init?.body });
      if (request.url.endsWith("/me")) {
        return Response.json({ user: { id: "user_1", email: "person@example.test" }, csrfToken: "csrf_1" });
      }
      if (request.method === "GET") {
        return Response.json({ entries: [] });
      }
      return Response.json(request.method === "PUT" ? { path: "files/reports/brief.bin", bytes: 3 } : { deleted: true });
    };

    try {
      await apiClient.currentIdentity();
      await apiClient.files("project_1", "files/reports");
      await apiClient.uploadFile("project_1", "files/reports/brief.bin", new Blob([Uint8Array.from([0, 255, 7])], { type: "application/octet-stream" }) as File, { idempotencyKey: "file-upload-key" });
      await apiClient.deleteFile("project_1", "files/reports/brief.bin");

      assert.equal(requests[1]?.url, "http://localhost/api/v1/projects/project_1/files?path=files%2Freports");
      assert.deepEqual(requests[2] && { method: requests[2].method, contentType: requests[2].contentType, csrf: requests[2].csrf, idempotencyKey: requests[2].idempotencyKey }, { method: "PUT", contentType: "application/octet-stream", csrf: "csrf_1", idempotencyKey: "file-upload-key" });
      assert.deepEqual(requests[3] && { method: requests[3].method, contentType: requests[3].contentType, csrf: requests[3].csrf }, { method: "DELETE", contentType: "application/json", csrf: "csrf_1" });
      assert.equal(apiClient.fileDownloadUrl("project_1", "files/reports/brief.bin"), "/api/v1/projects/project_1/files/download?path=files%2Freports%2Fbrief.bin");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
