import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { TaskDetail } from "../../src/lib/api/client.js";
import { ApiError, apiClient } from "../../src/lib/api/client.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("task terminal API client", () => {
  it("preserves the complete nested API error envelope", async () => {
    const canonical = presentation("released");
    globalThis.fetch = apiFetch(() => Response.json({
      error: {
        code: "project_sandbox_capacity_reached",
        message: "Project Sandbox capacity reached",
        retryable: true,
        details: { activeSandboxes: 2, sandboxLimit: 2 },
        presentation: canonical
      }
    }, { status: 409 }));

    await assert.rejects(
      apiClient.sendTaskMessage("task_1", "Keep going", "message-key"),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "project_sandbox_capacity_reached");
        assert.equal(error.message, "Project Sandbox capacity reached");
        assert.equal(error.retryable, true);
        assert.deepEqual(error.details, { activeSandboxes: 2, sandboxLimit: 2 });
        assert.deepEqual(error.presentation, canonical);
        return true;
      }
    );
  });

  it("does not treat legacy top-level capacity fields as the structured envelope", async () => {
    globalThis.fetch = apiFetch(() => Response.json({
      error: "Project Sandbox capacity reached",
      code: "project_sandbox_capacity_reached",
      retryable: true,
      details: { activeSandboxes: 2, sandboxLimit: 2 },
      presentation: presentation("released")
    }, { status: 409 }));

    await assert.rejects(
      apiClient.sendTaskMessage("task_1", "Keep going", "message-key"),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.retryable, undefined);
        assert.equal(error.details, undefined);
        assert.equal(error.presentation, undefined);
        assert.equal(error.code, undefined);
        return true;
      }
    );
  });

  it("keeps ordinary top-level codes while degrading malformed capacity envelopes to generic errors", async () => {
    globalThis.fetch = apiFetch(() => Response.json({
      error: "File Library is unavailable",
      code: "file_library_not_found"
    }, { status: 404 }));
    await assert.rejects(
      apiClient.sendTaskMessage("task_1", "Keep going", "message-key"),
      (error: unknown) => error instanceof ApiError && error.code === "file_library_not_found"
    );

    for (const nested of [
      {
        code: "project_sandbox_capacity_reached",
        message: "Project Sandbox capacity reached",
        retryable: false,
        details: { activeSandboxes: 2, sandboxLimit: 2 },
        presentation: null
      },
      {
        code: "project_sandbox_capacity_reached",
        message: "Project Sandbox capacity reached",
        retryable: true,
        details: null,
        presentation: null
      },
      {
        code: "substrate_sandbox_capacity_reached",
        message: "Local Sandbox capacity unavailable",
        retryable: true,
        details: { activeSandboxes: 2, sandboxLimit: 2 },
        presentation: null
      },
      {
        code: "sandbox_start_failed",
        message: "Sandbox could not be started",
        retryable: true,
        details: null,
        presentation: null
      },
      {
        code: "substrate_sandbox_capacity_reached",
        message: "Local Sandbox capacity unavailable",
        retryable: true,
        details: null,
        presentation: null,
        legacyCapacity: 2
      }
    ]) {
      globalThis.fetch = apiFetch(() => Response.json({ error: nested }, { status: 409 }));
      await assert.rejects(
        apiClient.sendTaskMessage("task_1", "Keep going", "message-key"),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.message, nested.message);
          assert.equal(error.code, undefined);
          assert.equal(error.retryable, undefined);
          assert.equal(error.details, undefined);
          assert.equal(error.presentation, undefined);
          return true;
        }
      );
    }
  });

  it("types only capacity with null presentation for Create", async () => {
    await assertTypedSandboxError(
      () => apiClient.createTask("project_1", createInput(), "create-key"),
      capacityEnvelope("project_sandbox_capacity_reached", null)
    );
    await assertTypedSandboxError(
      () => apiClient.createTask("project_1", createInput(), "create-key"),
      capacityEnvelope("substrate_sandbox_capacity_reached", null)
    );
    for (const nested of [
      capacityEnvelope("project_sandbox_capacity_reached", presentation("released")),
      startFailedEnvelope(presentation("failed")),
      {
        ...capacityEnvelope("project_sandbox_capacity_reached", null),
        details: null
      },
      {
        ...capacityEnvelope("substrate_sandbox_capacity_reached", null),
        details: { activeSandboxes: 2, sandboxLimit: 2 }
      },
      {
        ...capacityEnvelope("substrate_sandbox_capacity_reached", null),
        extra: "legacy"
      }
    ]) {
      await assertGenericSandboxError(
        () => apiClient.createTask("project_1", createInput(), "create-key"),
        nested
      );
    }
  });

  it("types only capacity with a released presentation for Send", async () => {
    await assertTypedSandboxError(
      () => apiClient.sendTaskMessage("task_1", "Keep going", "message-key"),
      capacityEnvelope("project_sandbox_capacity_reached", presentation("released"))
    );
    await assertTypedSandboxError(
      () => apiClient.sendTaskMessage("task_1", "Keep going", "message-key"),
      capacityEnvelope("substrate_sandbox_capacity_reached", presentation("released"))
    );
    for (const nested of [
      capacityEnvelope("project_sandbox_capacity_reached", null),
      capacityEnvelope("substrate_sandbox_capacity_reached", presentation("active")),
      startFailedEnvelope(presentation("failed")),
      {
        ...capacityEnvelope("project_sandbox_capacity_reached", presentation("released")),
        extra: "legacy"
      }
    ]) {
      await assertGenericSandboxError(
        () => apiClient.sendTaskMessage("task_1", "Keep going", "message-key"),
        nested
      );
    }
  });

  it("types only Terminal capacity released or start-failed cleanup presentations", async () => {
    await assertTypedSandboxError(
      () => apiClient.startTaskTerminal("task_1", "terminal-key"),
      capacityEnvelope("project_sandbox_capacity_reached", presentation("released"))
    );
    await assertTypedSandboxError(
      () => apiClient.startTaskTerminal("task_1", "terminal-key"),
      capacityEnvelope("substrate_sandbox_capacity_reached", presentation("released"))
    );
    await assertTypedSandboxError(
      () => apiClient.startTaskTerminal("task_1", "terminal-key"),
      startFailedEnvelope(presentation("failed"))
    );
    await assertTypedSandboxError(
      () => apiClient.startTaskTerminal("task_1", "terminal-key"),
      startFailedEnvelope(presentation("release_requested"))
    );
    for (const nested of [
      capacityEnvelope("project_sandbox_capacity_reached", null),
      capacityEnvelope("substrate_sandbox_capacity_reached", presentation("active")),
      startFailedEnvelope(null),
      startFailedEnvelope(presentation("released")),
      startFailedEnvelope(presentation("active")),
      {
        ...capacityEnvelope("project_sandbox_capacity_reached", presentation("released")),
        details: null
      },
      {
        ...capacityEnvelope("substrate_sandbox_capacity_reached", presentation("released")),
        details: { activeSandboxes: 2, sandboxLimit: 2 }
      },
      {
        ...startFailedEnvelope(presentation("failed")),
        extra: "legacy"
      }
    ]) {
      await assertGenericSandboxError(
        () => apiClient.startTaskTerminal("task_1", "terminal-key"),
        nested
      );
    }
  });

  it("posts an empty body and parses 202 in-progress and 200 active receipts", async () => {
    const requests: Request[] = [];
    let starts = 0;
    globalThis.fetch = async (input, init) => {
      const request = asRequest(input, init);
      requests.push(request);
      if (request.url.endsWith("/me")) {
        return Response.json({ user: { id: "user_1", email: "user@example.test" }, csrfToken: "csrf" });
      }
      starts += 1;
      return starts === 1
        ? Response.json({ status: "in_progress", runId: "run_1", presentation: presentation("starting") }, { status: 202 })
        : Response.json({ status: "active", runId: "run_1", presentation: presentation("active") }, { status: 200 });
    };

    await apiClient.currentIdentity();
    const pending = await apiClient.startTaskTerminal("task_1", "terminal-key");
    const active = await apiClient.startTaskTerminal("task_1", "terminal-key");

    assert.equal(pending.status, "in_progress");
    assert.equal(active.status, "active");
    assert.equal(requests[1]?.url, "http://localhost/api/v1/tasks/task_1/terminal/start");
    assert.equal(requests[1]?.headers.get("idempotency-key"), "terminal-key");
    assert.deepEqual(await requests[1]?.json(), {});
    assert.equal(requests[2]?.headers.get("idempotency-key"), "terminal-key");
  });
});

function apiFetch(response: () => Response): typeof fetch {
  return async (input, init) => {
    const request = asRequest(input, init);
    if (request.url.endsWith("/me")) {
      return Response.json({ user: { id: "user_1", email: "user@example.test" }, csrfToken: "csrf" });
    }
    return response();
  };
}

async function assertTypedSandboxError(
  operation: () => Promise<unknown>,
  nested: ReturnType<typeof capacityEnvelope> | ReturnType<typeof startFailedEnvelope>
): Promise<void> {
  globalThis.fetch = apiFetch(() => Response.json({ error: nested }, { status: 409 }));
  await assert.rejects(
    operation(),
    (error: unknown) => error instanceof ApiError
      && error.code === nested.code
      && error.retryable === true
      && (
        nested.presentation === null
          ? error.presentation === null
          : error.presentation?.sandboxState.state === nested.presentation.sandboxState.state
      )
  );
}

async function assertGenericSandboxError(
  operation: () => Promise<unknown>,
  nested: ReturnType<typeof capacityEnvelope> | ReturnType<typeof startFailedEnvelope>
): Promise<void> {
  globalThis.fetch = apiFetch(() => Response.json({ error: nested }, { status: 409 }));
  await assert.rejects(operation(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.message, nested.message);
    assert.equal(error.code, undefined);
    assert.equal(error.retryable, undefined);
    assert.equal(error.details, undefined);
    assert.equal(error.presentation, undefined);
    return true;
  });
}

function capacityEnvelope(
  code: "project_sandbox_capacity_reached" | "substrate_sandbox_capacity_reached",
  canonical: TaskDetail | null
) {
  return {
    code,
    message: code === "project_sandbox_capacity_reached"
      ? "Project Sandbox capacity reached"
      : "Local Sandbox capacity unavailable",
    retryable: true as const,
    details: code === "project_sandbox_capacity_reached"
      ? { activeSandboxes: 2, sandboxLimit: 2 }
      : null,
    presentation: canonical
  };
}

function startFailedEnvelope(canonical: TaskDetail | null) {
  return {
    code: "sandbox_start_failed" as const,
    message: "Sandbox could not be started",
    retryable: true as const,
    details: null,
    presentation: canonical
  };
}

function createInput() {
  return {
    prompt: "Prompt",
    endpointId: "endpoint_1",
    fileLibrary: { mode: "create_new" as const, name: "Task files" }
  };
}

function asRequest(input: string | URL | Request, init?: RequestInit): Request {
  return new Request(new URL(
    typeof input === "string" ? input : input instanceof URL ? input : input.url,
    "http://localhost"
  ), init);
}

function presentation(
  state: "starting" | "active" | "release_requested" | "released" | "failed"
): TaskDetail {
  return {
    task: {
      id: "task_1",
      workspaceId: "workspace_1",
      projectId: "project_1",
      endpointId: "endpoint_1",
      fileLibraryId: "library_1",
      title: "Task",
      prompt: "Prompt",
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z"
    },
    lifecycle: { state: "active" },
    currentTurn: { state: state === "active" ? "running" : state === "starting" ? "starting" : "ready" },
    sandboxState: {
      state,
      runId: "run_1",
      cause: state === "failed" || state === "release_requested"
        ? { code: "cleanup_failed", message: "Sandbox cleanup is pending" }
        : null
    },
    capabilities: {
      sendMessage: true,
      editQueuedMessage: false,
      abortTurn: false,
      stopWork: false,
      openTerminal: true,
      releaseSandbox: state === "active",
      editTask: true,
      archiveTask: true,
      deleteTask: true
    }
  };
}
