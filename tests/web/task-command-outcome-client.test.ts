import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ApiError,
  apiClient,
  taskCommandOutcomeError
} from "../../src/lib/api/client.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Task command outcome client", () => {
  it("parses accepted Task create and completed Task message outcomes", async () => {
    globalThis.fetch = apiFetch((request) => request.url.includes("/messages")
      ? Response.json({
          outcome: "completed",
          keyDisposition: "retire",
          messageId: "message_1",
          disposition: "queued_for_active_run",
          duplicate: false,
          queuedMessage: null,
          interaction: null,
          presentation: presentation("task_1")
        })
      : Response.json({
          outcome: "accepted_in_progress",
          keyDisposition: "retain",
          taskId: "task_1"
        }, { status: 202 }));

    const accepted = await apiClient.createTask("project_1", createInput(), "create-key");
    assert.deepEqual(accepted, {
      outcome: "accepted_in_progress",
      keyDisposition: "retain",
      taskId: "task_1"
    });

    const completed = await apiClient.sendTaskMessage("task_1", "Keep going", "message-key");
    assert.equal(completed.outcome, "completed");
    assert.equal(completed.keyDisposition, "retire");
    assert.equal(completed.messageId, "message_1");
  });

  it("parses an explicit rejected-before-acceptance disposition", async () => {
    globalThis.fetch = apiFetch(() => Response.json({
      outcome: "rejected_before_acceptance",
      keyDisposition: "retain",
      error: "Idempotency-Key was already used with a different request",
      code: "idempotency_payload_mismatch"
    }, { status: 409 }));

    const outcome = await apiClient.createTask("project_1", createInput(), "create-key");
    assert.deepEqual(outcome, {
      outcome: "rejected_before_acceptance",
      keyDisposition: "retain",
      error: "Idempotency-Key was already used with a different request",
      code: "idempotency_payload_mismatch"
    });
    assert.equal(outcome.outcome, "rejected_before_acceptance");
    const error = taskCommandOutcomeError(outcome);
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
  });

  it("synthesizes a retained unknown outcome for a dropped connection", async () => {
    globalThis.fetch = apiFetch(() => { throw new TypeError("connection dropped"); });
    const outcome = await apiClient.createTask("project_1", createInput(), "create-key");
    assertUnknown(outcome, /connection dropped/);
  });

  it("synthesizes a retained unknown outcome for HTTP 408", async () => {
    globalThis.fetch = apiFetch(() => Response.json({
      outcome: "rejected_before_acceptance",
      keyDisposition: "retire",
      error: "Request timed out"
    }, { status: 408 }));
    const outcome = await apiClient.createTask("project_1", createInput(), "create-key");
    assertUnknown(outcome, /outcome.*unknown/i);
  });

  it("synthesizes a retained unknown outcome for invalid JSON", async () => {
    globalThis.fetch = apiFetch(() => new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const outcome = await apiClient.sendTaskMessage("task_1", "Keep going", "message-key");
    assertUnknown(outcome, /invalid.*response/i);
  });

  it("synthesizes a retained unknown outcome for an unclassified 5xx", async () => {
    globalThis.fetch = apiFetch(() => Response.json({
      error: "Internal server error",
      retryable: false
    }, { status: 503 }));
    const outcome = await apiClient.sendTaskMessage("task_1", "Keep going", "message-key");
    assertUnknown(outcome, /outcome.*unknown/i);
  });

  it("synthesizes unknown for untyped idempotency-in-progress 409", async () => {
    globalThis.fetch = apiFetch(() => Response.json({
      error: "Idempotent operation is still in progress",
      code: "idempotency_in_progress"
    }, { status: 409 }));

    const outcome = await apiClient.createTask("project_1", createInput(), "create-key");
    assertUnknown(outcome, /invalid.*response/i);
  });

  it("requires a valid disposition and error body for typed rejection", async () => {
    globalThis.fetch = apiFetch((request) => request.url.includes("/messages")
      ? Response.json({
          outcome: "rejected_before_acceptance",
          keyDisposition: "retain",
          error: 42
        }, { status: 409 })
      : Response.json({
          outcome: "rejected_before_acceptance",
          error: "Missing key disposition"
        }, { status: 409 }));

    assertUnknown(
      await apiClient.createTask("project_1", createInput(), "create-key"),
      /invalid.*response/i
    );
    assertUnknown(
      await apiClient.sendTaskMessage("task_1", "Keep going", "message-key"),
      /invalid.*response/i
    );
  });

  it("rejects contract-invalid typed bodies, including message accepted_in_progress", async () => {
    globalThis.fetch = apiFetch((request) => request.url.includes("/messages")
      ? Response.json({
          outcome: "accepted_in_progress",
          keyDisposition: "retain",
          taskId: "task_1"
        }, { status: 202 })
      : Response.json({
          outcome: "completed",
          keyDisposition: "retain",
          ...presentation("task_1")
        }));

    assertUnknown(
      await apiClient.createTask("project_1", createInput(), "create-key"),
      /invalid.*response/i
    );
    assertUnknown(
      await apiClient.sendTaskMessage("task_1", "Keep going", "message-key"),
      /invalid.*response/i
    );
  });

  it("treats a server body claiming outcome_unknown as contract-invalid", async () => {
    globalThis.fetch = apiFetch(() => Response.json({
      outcome: "outcome_unknown",
      keyDisposition: "retire",
      error: "A server must never serialize this state"
    }, { status: 503 }));

    const outcome = await apiClient.sendTaskMessage("task_1", "Keep going", "message-key");
    assertUnknown(outcome, /invalid.*response/i);
  });
});

function assertUnknown(
  outcome: { outcome: string; keyDisposition: string; error?: unknown },
  message: RegExp
): void {
  assert.equal(outcome.outcome, "outcome_unknown");
  assert.equal(outcome.keyDisposition, "retain");
  assert.ok(outcome.error instanceof Error);
  assert.match(outcome.error.message, message);
}

function apiFetch(response: (request: Request) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => {
    const request = new Request(
      new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url, "http://localhost"),
      init
    );
    if (request.url.endsWith("/me")) {
      return Response.json({ user: { id: "user_1", email: "user@example.test" }, csrfToken: "csrf" });
    }
    return response(request);
  };
}

function createInput() {
  return {
    prompt: "Prepare release",
    endpointId: "endpoint_1",
    title: "Release",
    fileLibrary: { mode: "create_new" as const, name: "Release files" }
  };
}

function presentation(taskId: string) {
  return {
    task: {
      id: taskId,
      workspaceId: "workspace_1",
      projectId: "project_1",
      endpointId: "endpoint_1",
      fileLibraryId: "library_1",
      title: "Release",
      prompt: "Prepare release",
      createdAt: "2026-07-26T12:00:00.000Z",
      updatedAt: "2026-07-26T12:00:00.000Z"
    },
    lifecycle: { state: "active" },
    sandboxState: { state: "released", runId: null, cause: null },
    currentTurn: { state: "ready", abortable: false },
    capabilities: {
      sendMessage: true,
      editQueuedMessage: true,
      abortTurn: false,
      openTerminal: false,
      releaseSandbox: false,
      editTask: true,
      archiveTask: true,
      deleteTask: true
    }
  };
}
