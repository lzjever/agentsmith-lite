import assert from "node:assert/strict";
import test from "node:test";
import { apiClient } from "../../src/lib/api/client.ts";

test("linked notification reads use keepalive and preserve CSRF/session request behavior", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(
      new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url, "http://localhost"),
      init
    );
    requests.push(request);
    if (request.url.endsWith("/me")) {
      return Response.json({
        user: { id: "user_1", email: "person@example.test" },
        csrfToken: "csrf_1"
      });
    }
    return Response.json({
      id: "notification_1",
      type: "task.completed",
      title: "Task completed",
      body: null,
      projectId: "project_1",
      resourceKind: "task",
      resourceId: "task_1",
      linkPath: "/workspaces/workspace_1/projects/project_1/tasks/task_1",
      readAt: "2026-07-24T12:00:00.000Z",
      createdAt: "2026-07-24T11:00:00.000Z"
    });
  };

  try {
    await apiClient.markLinkedNotificationRead("notification_1");

    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.url, "http://localhost/api/v1/me");
    assert.equal(requests[1]!.url, "http://localhost/api/v1/notifications/notification_1/read");
    assert.equal(requests[1]!.method, "PATCH");
    assert.equal(requests[1]!.keepalive, true);
    assert.equal(requests[1]!.credentials, "same-origin");
    assert.equal(requests[1]!.headers.get("x-csrf-token"), "csrf_1");
    assert.equal(requests[1]!.headers.get("content-type"), "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
