import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, apiClient, type ProjectFile } from "../../src/lib/api/client.js";

describe("file libraries API client", () => {
  it("uses the project File Library CRUD contract", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url, "http://localhost"), init);
      requests.push(request);
      if (request.url.endsWith("/me")) return Response.json({ user: { id: "user_1", email: "person@example.test" }, csrfToken: "csrf_1" });
      if (request.method === "DELETE") return Response.json({ deleted: true });
      return Response.json(request.method === "GET" ? [] : library("library_1", request.method === "PATCH" ? "Renamed" : "Design files"));
    };

    try {
      await apiClient.currentIdentity();
      await apiClient.fileLibraries("project_1");
      await apiClient.createFileLibrary("project_1", "Design files", "create-key");
      await apiClient.renameFileLibrary("project_1", "library_1", { name: "Renamed", expectedUpdatedAt: "2026-07-19T00:00:00.000Z" }, "rename-key");
      await apiClient.deleteFileLibrary("project_1", "library_1", "delete-key");

      assert.deepEqual(requests.slice(1).map((request) => [request.method, request.url, request.headers.get("idempotency-key")]), [
        ["GET", "http://localhost/api/v1/projects/project_1/file-libraries", null],
        ["POST", "http://localhost/api/v1/projects/project_1/file-libraries", "create-key"],
        ["PATCH", "http://localhost/api/v1/projects/project_1/file-libraries/library_1", "rename-key"],
        ["DELETE", "http://localhost/api/v1/projects/project_1/file-libraries/library_1", "delete-key"]
      ]);
      assert.deepEqual(await requests[2]!.json(), { name: "Design files" });
      assert.deepEqual(await requests[3]!.json(), { name: "Renamed", expectedUpdatedAt: "2026-07-19T00:00:00.000Z" });
      assert.deepEqual(await requests[4]!.json(), {});
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses library-scoped list, upload, preview, download, and delete URLs", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url, "http://localhost"), init);
      requests.push(request);
      if (request.url.endsWith("/me")) return Response.json({ user: { id: "user_1", email: "person@example.test" }, csrfToken: "csrf_1" });
      if (request.method === "GET" && !request.url.includes("/preview")) return Response.json({
        entries: [{
          name: "brief.txt",
          path: "reports/brief.txt",
          type: "file",
          size: 3,
          mediaType: "text/plain",
          updatedAt: "x",
          capabilities: {
            canDelete: false,
            deleteUnavailableReason: "read_only"
          }
        }]
      });
      if (request.method === "GET") return new Response("preview", { headers: { "content-type": "text/plain" } });
      return Response.json(request.method === "PUT" ? { path: "reports/brief.txt", bytes: 3, mediaType: "text/plain", updatedAt: "x" } : { deleted: true });
    };

    try {
      await apiClient.currentIdentity();
      const listed = await apiClient.libraryFiles("project_1", "library_1", "reports");
      await apiClient.uploadLibraryFile("project_1", "library_1", "reports/brief.txt", new File(["abc"], "brief.txt", { type: "text/plain" }), { idempotencyKey: "upload-key" });
      await apiClient.previewLibraryFile("project_1", "library_1", "reports/brief.txt");
      await apiClient.deleteLibraryFile("project_1", "library_1", "reports/brief.txt", "delete-file-key");

      assert.equal(requests[1]!.url, "http://localhost/api/v1/projects/project_1/file-libraries/library_1/files?path=reports");
      const entry: ProjectFile = listed.entries[0]!;
      assert.deepEqual(entry.capabilities, {
        canDelete: false,
        deleteUnavailableReason: "read_only"
      });
      assert.deepEqual([requests[2]!.method, requests[2]!.headers.get("content-type"), requests[2]!.headers.get("idempotency-key")], ["PUT", "text/plain", "upload-key"]);
      assert.equal(requests[2]!.url, "http://localhost/api/v1/projects/project_1/file-libraries/library_1/files?path=reports%2Fbrief.txt");
      assert.equal(requests[3]!.url, "http://localhost/api/v1/projects/project_1/file-libraries/library_1/files/preview?path=reports%2Fbrief.txt");
      assert.deepEqual(await requests[4]!.json(), { path: "reports/brief.txt" });
      assert.equal(apiClient.libraryFileDownloadUrl("project_1", "library_1", "reports/brief.txt"), "/api/v1/projects/project_1/file-libraries/library_1/files/download?path=reports%2Fbrief.txt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves the typed missing-path code from a folder listing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json(
      { error: "File path not found", code: "file_path_not_found" },
      { status: 404 }
    );

    try {
      await assert.rejects(
        apiClient.libraryFiles("project_1", "library_1", "removed/folder"),
        (error) => error instanceof ApiError
          && error.status === 404
          && error.code === "file_path_not_found"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function library(id: string, name: string) {
  return {
    id,
    workspaceId: "workspace_1",
    projectId: "project_1",
    name,
    rootSubPath: `file-libraries/${id}`,
    createdByUserId: "user_1",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    boundTask: null,
    capabilities: { canRename: true, canDelete: true, canWriteFiles: true }
  };
}
