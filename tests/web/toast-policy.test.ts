import assert from "node:assert/strict";
import test from "node:test";
import { appendToast, type ToastMessage } from "../../src/components/ui/toast-policy.js";

test("new success feedback replaces stale successes without hiding errors", () => {
  const error = message("error", "Endpoint is unavailable");
  const saved = message("success", "Workspace settings saved");
  const restored = message("success", "Workspace restored");

  const messages = appendToast(appendToast(appendToast([], error), saved), restored);

  assert.deepEqual(messages.map(({ type, message }) => ({ type, message })), [
    { type: "error", message: "Endpoint is unavailable" },
    { type: "success", message: "Workspace restored" },
  ]);
});

function message(type: ToastMessage["type"], value: string): ToastMessage {
  return { id: value, type, message: value, duration: 10_000 };
}
