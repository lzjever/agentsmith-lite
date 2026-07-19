import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import type { TaskCapabilities, TaskInteractionSnapshot } from "../../src/lib/api/client.js";
import { ApiError, apiClient } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { TaskConversationWorkspace } = await import("../../src/components/tasks/TaskConversationWorkspace.js");

afterEach(() => cleanup());

describe("TaskConversationWorkspace", () => {
  it("stops reconnecting and invalidates the task when conversation access is gone", async () => {
    const original = { getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    let attempts = 0;
    let unavailable = 0;
    apiClient.getTaskInteractions = async () => { attempts += 1; throw new ApiError(404, "Task not found"); };
    try {
      render(<TaskConversationWorkspace taskId="task_1" onCapabilities={() => undefined} onUnavailable={() => { unavailable += 1; }} onArtifactPublished={() => undefined} />);
      await waitFor(() => assert.equal(unavailable, 1));
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assert.equal(attempts, 1);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("refreshes interaction capabilities when sending discovers the project is read-only", async () => {
    const original = { getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions, sendTaskMessage: apiClient.sendTaskMessage };
    let reads = 0;
    apiClient.getTaskInteractions = async () => ({ ...snapshot, capabilities: reads++ === 0 ? capabilities : { ...capabilities, sendMessage: false } });
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    apiClient.sendTaskMessage = async () => { throw new ApiError(409, "Project is archived"); };
    try {
      render(<TaskConversationWorkspace taskId="task_1" onCapabilities={() => undefined} onArtifactPublished={() => undefined} />);
      const composer = await screen.findByLabelText("Message") as HTMLTextAreaElement;
      fireEvent.change(composer, { target: { value: "Continue" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() => assert.equal(reads, 2));
      assert.equal(composer.disabled, true);
      assert.ok(screen.getByText("Project is archived"));
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("uses a new message key after a definitive API failure", async () => {
    const original = { getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions, sendTaskMessage: apiClient.sendTaskMessage };
    const keys: string[] = [];
    apiClient.getTaskInteractions = async () => snapshot;
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    apiClient.sendTaskMessage = async (_taskId, _content, key) => {
      keys.push(key);
      if (keys.length === 1) throw new ApiError(409, "Task message state changed");
      return { messageId: "message_2", disposition: "queued_for_active_run", duplicate: false, queuedMessage: null, interaction: null, capabilities };
    };
    try {
      render(<TaskConversationWorkspace taskId="task_1" onCapabilities={() => undefined} onArtifactPublished={() => undefined} />);
      const composer = await screen.findByLabelText("Message") as HTMLTextAreaElement;
      fireEvent.change(composer, { target: { value: "Continue after recovery" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await screen.findByText("Task message state changed");

      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => assert.equal(composer.value, ""));
      assert.equal(keys.length, 2);
      assert.notEqual(keys[0], keys[1]);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("reconciles a queued message that was consumed before editing", async () => {
    const original = { getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions, updateTaskMessage: apiClient.updateTaskMessage };
    const queued = { id: "message_queued", content: "Queued instruction", deliveryStatus: "pending" as const, editable: true, deletable: true, updatedAt: "2026-07-15T00:00:01.000Z" };
    const editableCapabilities = { ...capabilities, editQueuedMessage: true };
    let reads = 0;
    let unavailable = 0;
    apiClient.getTaskInteractions = async () => ({ ...snapshot, queuedMessages: reads++ === 0 ? [queued] : [], capabilities: editableCapabilities });
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    apiClient.updateTaskMessage = async () => { throw new ApiError(404, "Task message not found"); };
    try {
      render(<TaskConversationWorkspace taskId="task_1" onCapabilities={() => undefined} onUnavailable={() => { unavailable += 1; }} onArtifactPublished={() => undefined} />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit queued message" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Queued message" }), { target: { value: "Updated instruction" } });
      fireEvent.click(screen.getByRole("button", { name: "Save message" }));

      await waitFor(() => assert.equal(reads, 2));
      await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Edit queued message" }), null));
      assert.equal(screen.queryByText("Queued instruction"), null);
      assert.equal(screen.queryByText("Task message not found"), null);
      assert.equal(unavailable, 0);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("removes a deleted queued message from the durable conversation", async () => {
    const original = { getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions, deleteTaskMessage: apiClient.deleteTaskMessage };
    const queued = { id: "message_queued", content: "Queued instruction", deliveryStatus: "pending" as const, editable: true, deletable: true, updatedAt: "2026-07-15T00:00:01.000Z" };
    const queuedInteraction = { ...interaction, id: "interaction_queued", kind: "user_message" as const, title: "You", body: queued.content, status: "queued" as const };
    const editableCapabilities = { ...capabilities, editQueuedMessage: true };
    let reads = 0;
    apiClient.getTaskInteractions = async () => reads++ === 0
      ? { ...snapshot, items: [queuedInteraction], queuedMessages: [queued], capabilities: editableCapabilities }
      : { ...snapshot, items: [], queuedMessages: [], capabilities: editableCapabilities };
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    apiClient.deleteTaskMessage = async () => ({ messageId: queued.id, disposition: "accepted_by_active_run", duplicate: false, queuedMessage: null, interaction: null, capabilities: editableCapabilities });
    try {
      render(<TaskConversationWorkspace taskId="task_1" onCapabilities={() => undefined} onArtifactPublished={() => undefined} />);
      fireEvent.click(await screen.findByRole("button", { name: "Delete queued message" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete message" }));

      await waitFor(() => assert.equal(reads, 2));
      await waitFor(() => assert.equal(screen.queryByText("Queued instruction"), null));
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("keeps the initial snapshot error and Retry reachable", async () => {
    const original = { getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    let attempts = 0;
    apiClient.getTaskInteractions = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Snapshot service unavailable");
      return snapshot;
    };
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    try {
      render(<TaskConversationWorkspace taskId="task_1" onCapabilities={() => undefined} onArtifactPublished={() => undefined} />);
      assert.ok(await screen.findByRole("alert"));
      assert.ok(screen.getByText("Snapshot service unavailable"));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByRole("region", { name: "Task conversation workspace" });
      await waitFor(() => assert.equal(attempts, 2));
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("consumes independent server state, run state, and connection events", async () => {
    const original = { getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    const observedCapabilities: TaskCapabilities[] = [];
    const observedRunStates: TaskInteractionSnapshot["runState"][] = [];
    const queuedMessages = [{ id:"message_1", content:"Queued by server", deliveryStatus:"pending" as const, editable:false, deletable:false, updatedAt:"2026-07-15T00:00:01.000Z" }];
    const disabledCapabilities: TaskCapabilities = { ...capabilities, sendMessage:false, openTerminal:false };
    apiClient.getTaskInteractions = async () => snapshot;
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal, onEvent) => {
      onEvent({ type:"state", queuedMessages, capabilities:disabledCapabilities });
      onEvent({ type:"run_state", runState:"running" });
      onEvent({ type:"connection", connectionState:"disconnected", runtimeReachability:"unreachable", historyStatus:"gap", lastSyncedAt:"2026-07-15T00:00:02.000Z", message:"History recovery is incomplete." });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once:true }));
    };
    try {
      render(<TaskConversationWorkspace taskId="task_1" onCapabilities={(value) => observedCapabilities.push(value)} onRunState={(value) => observedRunStates.push(value)} onArtifactPublished={() => undefined} />);
      assert.ok(await screen.findByText("Working"));
      assert.ok(screen.getByText("Queued by server"));
      assert.ok(screen.getByText("Some earlier interaction history is no longer available."));
      assert.equal((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled, true);
      assert.deepEqual(observedCapabilities.at(-1), disabledCapabilities);
      assert.equal(observedRunStates.at(-1), "running");
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("presents preview degradation without claiming conversation updates disconnected", async () => {
    const original = { getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    apiClient.getTaskInteractions = async () => snapshot;
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal, onEvent) => {
      onEvent({ type:"connection", connectionState:"connected", runtimeReachability:"reachable", historyStatus:"complete", lastSyncedAt:"2026-07-15T00:00:02.000Z", message:null });
      onEvent({ type:"preview_status", previewStatus:"unavailable", message:"Live assistant preview is unavailable. Final responses and conversation updates remain available." });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once:true }));
    };
    try {
      render(<TaskConversationWorkspace taskId="task_1" onCapabilities={() => undefined} onArtifactPublished={() => undefined} />);
      assert.ok(await screen.findByText("Live assistant preview is unavailable. Final responses and conversation updates remain available."));
      assert.equal(screen.queryByText(/Conversation updates are temporarily disconnected/), null);
      assert.ok(screen.getByRole("button", { name:"Retry preview" }));
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("shows recovery when a reconnect receives a connected event", async () => {
    const original = { getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    let attempts = 0;
    apiClient.getTaskInteractions = async () => snapshot;
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal, onEvent) => {
      attempts += 1;
      if (attempts === 1) throw new Error("Stream temporarily unavailable");
      onEvent({ type:"connection", connectionState:"connected", runtimeReachability:"reachable", historyStatus:"complete", lastSyncedAt:"2026-07-15T00:00:02.000Z", message:null });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once:true }));
    };
    try {
      render(<TaskConversationWorkspace taskId="task_1" onCapabilities={() => undefined} onArtifactPublished={() => undefined} />);
      assert.ok(await screen.findByText(/Conversation updates are temporarily disconnected\. Stream temporarily unavailable/));
      assert.ok(await screen.findByText("Conversation updates recovered.", undefined, { timeout:3_000 }));
      assert.equal(attempts, 2);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("reports a failed turn stop and leaves it retryable", async () => {
    const original = { getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions, abortTaskTurn: apiClient.abortTaskTurn };
    apiClient.getTaskInteractions = async () => ({ ...snapshot, capabilities:{ ...capabilities, abortTurn:true }, runState:"running" });
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once:true }));
    };
    apiClient.abortTaskTurn = async () => { throw new Error("Current turn could not be stopped."); };
    try {
      render(<TaskConversationWorkspace taskId="task_1" onCapabilities={() => undefined} onArtifactPublished={() => undefined} />);
      fireEvent.click(await screen.findByRole("button", { name:"Stop current turn" }));
      assert.ok(await screen.findByRole("alert"));
      assert.ok(screen.getByText("Current turn could not be stopped."));
      assert.equal((screen.getByRole("button", { name:"Stop current turn" }) as HTMLButtonElement).disabled, false);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("reports an earlier history failure and lets the user retry it", async () => {
    const original = { getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    let reads = 0;
    apiClient.getTaskInteractions = async (_taskId, cursor) => {
      if (!cursor) return { ...snapshot, nextPageCursor:"older_1", hasMoreBefore:true };
      reads += 1;
      if (reads === 1) throw new Error("Earlier history is unavailable");
      return { ...snapshot, items:[interaction], streamCursor:"older_cursor" };
    };
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once:true }));
    };
    try {
      render(<TaskConversationWorkspace taskId="task_1" onCapabilities={() => undefined} onArtifactPublished={() => undefined} />);
      fireEvent.click(await screen.findByRole("button", { name:"Load earlier messages" }));
      assert.ok(await screen.findByText("Earlier history is unavailable"));
      fireEvent.click(screen.getByRole("button", { name:"Load earlier messages" }));
      assert.ok(await screen.findByText("Earlier message"));
      assert.equal(screen.queryByText("Earlier history is unavailable"), null);
      assert.equal(reads, 2);
    } finally {
      Object.assign(apiClient, original);
    }
  });

});

const capabilities: TaskCapabilities = { sendMessage: true, editQueuedMessage: false, abortTurn: false, cancelTask: true, openTerminal: true, editTask:true, archiveTask:false, deleteTask: false };
const snapshot: TaskInteractionSnapshot = { items: [], nextPageCursor: null, hasMoreBefore: false, streamCursor: "cursor_1", historyStatus: "complete", queuedMessages: [], runState: "idle", runtimeReachability: "reachable", lastSyncedAt: "2026-07-15T00:00:00.000Z", capabilities };
const interaction: TaskInteractionSnapshot["items"][number] = { id:"message_older", revision:1, taskId:"task_1", kind:"assistant_message", title:"Assistant", body:"Earlier message", contentMode:"full", occurredAt:"2026-07-14T00:00:00.000Z", updatedAt:"2026-07-14T00:00:00.000Z", status:"completed" };

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, Element: dom.window.Element, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
}
