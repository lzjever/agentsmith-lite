import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import type { TaskInteractionItem } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { TaskInteractionList, upsertTaskInteractions } = await import("../../src/components/tasks/TaskInteractionList.js");
const { apiClient } = await import("../../src/lib/api/client.js");

afterEach(() => cleanup());

const base = { taskId: "task_1", revision: 1, title: "A task interaction", body: "Details", contentMode: "full", position: 1, occurredAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" };

describe("task interaction list", () => {
  it("upserts a newer revision in place and preserves chronological order", () => {
    const older = itemFor("assistant_message", 1);
    const newer = { ...older, revision: 2, body: "Final response" } as TaskInteractionItem;
    const later = itemFor("system_error", 2);
    const result = upsertTaskInteractions([later, newer], [older]);
    assert.deepEqual(result.map((item) => [item.id, item.revision]), [["item_assistant_message", 2], ["item_system_error", 1]]);
  });

  it("renders server-owned interaction kinds without exposing raw payloads", () => {
    const items = (["user_message", "assistant_message", "tool", "background_task", "task_question", "task_notice", "task_result", "subagent_result", "file", "execution_boundary", "system_error"] as const).map((kind, index) => itemFor(kind, index));
    render(<TaskInteractionList taskId="task_1" items={items} preview={null} basePath="/tasks" onStopWork={async () => undefined} />);
    assert.equal(screen.getAllByRole("listitem").length, 11);
    assert.equal(screen.queryByText("cursor"), null);
    assert.ok(screen.getByText("pwd"));
    assert.ok(screen.getByText("Packaging"));
    assert.ok(screen.getByText("Check inputs"));
  });

  it("labels partial and omitted content from the server contract", () => {
    const user = { ...itemFor("user_message", 1), contentMode: "preview" } as TaskInteractionItem;
    const tool = { ...itemFor("tool", 2), contentMode: "none", detailsOmitted: true } as TaskInteractionItem;
    render(<TaskInteractionList taskId="task_1" items={[user, tool]} preview={null} basePath="/tasks" onStopWork={async () => undefined} />);
    assert.ok(screen.getByText("Preview only"));
    assert.ok(screen.getByText("Content omitted · Some details omitted"));
  });

  it("copies assistant message content with the retained icon action", async () => {
    const writes: string[] = [];
    Object.assign(navigator, { clipboard: { writeText: async (value: string) => { writes.push(value); } } });
    render(<TaskInteractionList taskId="task_1" items={[itemFor("assistant_message", 1)]} preview={null} basePath="/tasks" onStopWork={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => assert.deepEqual(writes, ["Details"]));
  });

  it("states system error retryability without offering an unsupported retry action", () => {
    const retryable = itemFor("system_error", 1);
    const terminal = { ...itemFor("system_error", 2), id: "error_terminal", retryable: false } as TaskInteractionItem;
    render(<TaskInteractionList taskId="task_1" items={[retryable, terminal]} preview={null} basePath="/tasks" onStopWork={async () => undefined} />);
    assert.ok(screen.getByText("Retryable"));
    assert.ok(screen.getByText("Not retryable"));
    assert.equal(screen.queryByRole("button", { name: "Retry" }), null);
  });

  it("does not offer a download for a failed file projection", () => {
    const failed = { ...itemFor("file", 1), status: "failed", body: "Artifact projection failed" } as TaskInteractionItem;
    render(<TaskInteractionList taskId="task_1" items={[failed]} preview={null} basePath="/tasks" onStopWork={async () => undefined} />);
    assert.ok(screen.getByText("Artifact unavailable"));
    assert.equal(screen.queryByRole("button", { name: "Preview" }), null);
    assert.equal(screen.queryByRole("link", { name: "Download result.txt" }), null);
  });

  it("previews supported interaction files through the authorized artifact API", async () => {
    const original = apiClient.downloadTaskArtifact;
    apiClient.downloadTaskArtifact = async () => new Blob(["interaction preview"], { type: "text/plain" });
    try {
      render(<TaskInteractionList taskId="task_1" items={[itemFor("file", 1)]} preview={null} basePath="/tasks" onStopWork={async () => undefined} />);
      assert.match(screen.getByRole("link", { name: "Download result.txt" }).getAttribute("href") ?? "", /\/api\/v1\/tasks\/task_1\/artifacts\/artifact_1\/download$/);
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      assert.equal((await screen.findByText("interaction preview")).textContent, "interaction preview");
    } finally { apiClient.downloadTaskArtifact = original; }
  });

  it("opens image interactions from an authorized artifact blob", async () => {
    const originalDownload = apiClient.downloadTaskArtifact;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    apiClient.downloadTaskArtifact = async () => new Blob([Uint8Array.of(1)], { type: "image/png" });
    URL.createObjectURL = () => "blob:interaction-image";
    URL.revokeObjectURL = () => undefined;
    try {
      const image = { ...itemFor("file", 1), name: "result.png", mediaType: "image/png" } as TaskInteractionItem;
      render(<TaskInteractionList taskId="task_1" items={[image]} preview={null} basePath="/tasks" onStopWork={async () => undefined} />);
      fireEvent.click(screen.getByRole("button", { name: "View result.png" }));
      await screen.findByRole("img", { name: "result.png" });
    } finally {
      apiClient.downloadTaskArtifact = originalDownload;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});

function itemFor(kind: TaskInteractionItem["kind"], position: number): TaskInteractionItem {
  const shared = { ...base, id: `item_${kind}`, kind, title: kind.replaceAll("_", " "), position };
  switch (kind) {
    case "user_message": return { ...shared, kind, status: "accepted" };
    case "assistant_message": return { ...shared, kind, status: "completed" };
    case "tool": return { ...shared, kind, executionStatus: "completed", deliveryStatus: "delivered", toolName: "bash", command: "pwd", outputTail: "/workspace", exitCode: 0, detailsOmitted: false, canStop: false };
    case "background_task": return { ...shared, kind, executionStatus: "completed", deliveryStatus: "delivered", label: "Build artifact", workSummary: "Packaging", result: "Complete", error: null, detailsOmitted: false, canStop: false };
    case "task_question": return { ...shared, kind, status: "answered", question: "Proceed?", expect: "yes/no", answer: "yes" };
    case "task_notice": return { ...shared, kind, status: "accepted", sender: "Background work" };
    case "task_result": return { ...shared, kind, executionStatus: "completed", deliveryStatus: "delivered", result: "Complete", error: null, detailsOmitted: false };
    case "subagent_result": return { ...shared, kind, executionStatus: "completed", deliveryStatus: "delivered", name: "Research", purpose: "Check inputs", result: "Complete", error: null, detailsOmitted: false };
    case "file": return { ...shared, kind, status: "available", artifactId: "artifact_1", name: "result.txt", mediaType: "text/plain", bytes: 42 };
    case "execution_boundary": return { ...shared, kind, status: "successor_created", targetTaskId: "task_2" };
    case "system_error": return { ...shared, kind, status: "active", code: "runtime_unavailable", retryable: true, detailsOmitted: false };
    default: throw new Error(`Unsupported kind: ${kind}`);
  }
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLFormElement: dom.window.HTMLFormElement, Element: dom.window.Element, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, self: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
}
