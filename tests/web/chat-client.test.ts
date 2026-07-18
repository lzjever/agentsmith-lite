import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { ApiError, apiClient } from "../../src/lib/api/client.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it("parses a JSON API error before a chat stream starts", async () => {
  globalThis.fetch = async (input) => String(input).endsWith("/me")
    ? Response.json({ user: { id: "user_1", email: "user@example.test" }, csrfToken: "csrf" })
    : Response.json({ error: "Project provider requests limit reached" }, { status: 409 });

  await apiClient.currentIdentity();
  await assert.rejects(
    apiClient.sendChatMessage("project_1", "thread_1", "hello", null, undefined, () => {}),
    (error: unknown) => error instanceof ApiError
      && error.status === 409
      && error.message === "Project provider requests limit reached",
  );
});
