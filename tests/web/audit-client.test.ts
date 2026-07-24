import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ApiError, apiClient } from "../../src/lib/api/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const validEvent = {
  id: "audit_1",
  projectId: "project_1",
  actorId: "user_actor",
  subjectUserId: "user_subject",
  action: "task.create",
  status: "accepted",
  resourceKind: "task",
  resourceId: "task_1",
  createdAt: "2026-07-24T12:00:00.000Z",
  actorDisplayName: "Actor",
  actorEmail: "actor@example.test",
  subjectDisplayName: "Subject",
  subjectEmail: "subject@example.test",
};

describe("audit API client", () => {
  it("serializes the canonical list query exactly", async () => {
    let requested = "";
    globalThis.fetch = async (input) => {
      requested = requestUrl(input);
      return Response.json({ items: [validEvent], nextCursor: "opaque-next" });
    };

    const page = await apiClient.audit("project/1", {
      actorId: null,
      subjectUserId: "user_subject",
      action: "task.create",
      status: "accepted",
      resourceKind: "task",
      resourceId: "task_exact",
      from: "2026-07-24T00:00:00.000Z",
      to: "2026-07-24T23:59:59.999Z",
      cursor: "opaque+/=",
      limit: 20,
    });

    assert.equal(
      requested,
      "/api/v1/projects/project%2F1/audit?actorId=system&subjectUserId=user_subject&action=task.create&status=accepted&resourceKind=task&resourceId=task_exact&from=2026-07-24T00%3A00%3A00.000Z&to=2026-07-24T23%3A59%3A59.999Z&cursor=opaque%2B%2F%3D&limit=20",
    );
    assert.equal(page.items[0]?.actorDisplayName, "Actor");
  });

  it("rejects unknown action, resource, status, and malformed projections", async () => {
    for (const patch of [
      { action: "task.historical_terminal" },
      { resourceKind: "unknown" },
      { status: "unknown" },
      { actorDisplayName: 7 },
      { subjectEmail: undefined },
    ]) {
      globalThis.fetch = async () =>
        Response.json({
          items: [{ ...validEvent, ...patch }],
          nextCursor: null,
        });
      await assert.rejects(
        apiClient.audit("project_1"),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 502 &&
          error.message === "Audit response is invalid.",
      );
    }
  });

  it("serializes and validates scoped identity paging", async () => {
    let requested = "";
    globalThis.fetch = async (input) => {
      requested = requestUrl(input);
      return Response.json({
        items: [
          {
            id: "user_former",
            displayName: "Former User",
            email: "former@example.test",
          },
        ],
        nextCursor: null,
      });
    };

    const page = await apiClient.auditIdentities("project_1", {
      role: "subject",
      q: "Former User",
      cursor: "identity+/=",
      limit: 20,
    });

    assert.equal(
      requested,
      "/api/v1/projects/project_1/audit/identities?role=subject&q=Former+User&cursor=identity%2B%2F%3D&limit=20",
    );
    assert.equal(page.items[0]?.id, "user_former");

    globalThis.fetch = async () =>
      Response.json({
        items: [{ id: "user_1", displayName: null }],
        nextCursor: null,
      });
    await assert.rejects(
      apiClient.auditIdentities("project_1", { role: "actor", limit: 20 }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 502 &&
        error.message === "Audit identity response is invalid.",
    );
  });
});

function requestUrl(input: string | URL | Request): string {
  const value =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const url = new URL(value, "https://agentsmith.test");
  return `${url.pathname}${url.search}`;
}
