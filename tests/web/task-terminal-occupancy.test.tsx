import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it, mock } from "node:test";
import React from "react";
import type { TaskCapabilities, TaskInteractionStreamEvent } from "../../src/lib/api/client.js";
import { apiClient, type Task, type TaskArtifact } from "../../src/lib/api/client.js";

const sockets: TestWebSocket[] = [];
class TestWebSocket {
  static readonly OPEN = 1;
  readyState = TestWebSocket.OPEN;
  closed = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) { sockets.push(this); }
  send(_data: string): void {}
  close(): void { this.closed = true; this.readyState = 3; }
}

installDom();
const { Terminal } = await import("@xterm/xterm");
mock.method(Terminal.prototype, "loadAddon", () => undefined);
mock.method(Terminal.prototype, "open", () => undefined);
mock.method(Terminal.prototype, "focus", () => undefined);
mock.method(Terminal.prototype, "writeln", () => undefined);
mock.method(Terminal.prototype, "dispose", () => undefined);
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { TaskDetailPage } = await import("../../src/components/tasks/TaskDetailPage.js");

afterEach(() => { cleanup(); sockets.length = 0; });

describe("TaskDetailPage terminal occupancy", () => {
  it("keeps the owner's terminal mounted across occupancy and terminal-state updates until the user leaves", async () => {
    const original = { task: apiClient.task, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    let receive: ((event: TaskInteractionStreamEvent) => void) | undefined;
    apiClient.task = async () => task;
    apiClient.taskArtifacts = async () => [];
    apiClient.taskInputs = async () => [];
    apiClient.getTaskInteractions = async () => snapshot(available);
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal, onEvent) => {
      receive = onEvent;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };

    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      const terminalTab = await screen.findByRole("tab", { name: "Terminal" });
      const ownerTerminal = screen.getByRole("region", { name: "Task terminal" });
      await waitFor(() => assert.equal(sockets.length, 1));

      fireEvent.click(terminalTab);

      act(() => { for (const event of stateEvents("running", occupied)) receive?.(event); });
      assert.equal(screen.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected"), "true");
      assert.equal(screen.getByRole("region", { name: "Task terminal" }), ownerTerminal);

      act(() => { for (const event of stateEvents("terminal", occupied)) receive?.(event); });
      assert.equal(screen.getByRole("region", { name: "Task terminal" }), ownerTerminal);
      assert.equal(sockets.length, 1);
      assert.ok(screen.getByText(new RegExp(`terminal.*${task.id}`)));

      fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
      await waitFor(() => assert.equal(screen.queryByRole("tab", { name: "Terminal" }), null));
      assert.equal(screen.queryByRole("region", { name: "Task terminal" }), null);
      assert.equal(ownerTerminal.isConnected, false);
      assert.equal(sockets[0]?.closed, true);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("loads the artifacts-only view without touching broken conversation APIs", async () => {
    const original = { task: apiClient.task, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions };
    let interactionReads = 0;
    let inputReads = 0;
    const artifact: TaskArtifact = { id: "artifact_1", taskId: task.id, fileId: "file_1", name: "result.txt", bytes: 12, mediaType: "text/plain", createdAt: "2026-07-14T00:01:00.000Z" };
    apiClient.task = async () => task;
    apiClient.taskArtifacts = async () => [artifact];
    apiClient.taskInputs = async () => { inputReads += 1; throw new Error("Inputs unavailable"); };
    apiClient.getTaskInteractions = async () => { interactionReads += 1; throw new Error("Conversation unavailable"); };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} artifactsOnly />);
      await screen.findByText("result.txt");
      assert.equal(interactionReads, 0);
      assert.equal(inputReads, 0);
      assert.ok(screen.getByRole("link", { name: "Download result.txt" }));
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("keeps conversation readable when artifact and input panels fail", async () => {
    const original = { task: apiClient.task, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    apiClient.task = async () => task;
    apiClient.taskArtifacts = async () => { throw new Error("Artifact storage unavailable"); };
    apiClient.taskInputs = async () => { throw new Error("Input snapshot unavailable"); };
    apiClient.getTaskInteractions = async () => snapshot(available);
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      await screen.findByRole("region", { name: "Task conversation workspace" });
      assert.ok(screen.getByText("Artifacts unavailable"));
      assert.ok(screen.getByText("Task inputs unavailable"));
      assert.ok(screen.getByText("Artifact storage unavailable"));
      assert.ok(screen.getByText("Input snapshot unavailable"));
    } finally {
      Object.assign(apiClient, original);
    }
  });
});

const available: TaskCapabilities = { sendMessage: true, editQueuedMessage: false, abortTurn: false, cancelTask: true, openTerminal: true, deleteTask: false };
const occupied: TaskCapabilities = { ...available, openTerminal: false };
const task: Task = { id: "task_fa832", workspaceId: "workspace_1", projectId: "project_1", endpointId: "endpoint_1", prompt: "Inspect the workspace", status: "running", runId: "run_1", executionMode: "live", sandbox: { namespace: "task-f58", resources: [] }, createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z" };

function snapshot(capabilities: TaskCapabilities) {
  return { items: [], nextPageCursor: null, hasMoreBefore: false, streamCursor: "cursor_1", historyStatus: "complete" as const, queuedMessages: [], runState: "running" as const, runtimeReachability: "reachable" as const, lastSyncedAt: "2026-07-14T00:00:00.000Z", capabilities };
}

function stateEvents(runState:"running"|"terminal",capabilities:TaskCapabilities):TaskInteractionStreamEvent[] {
  return [{ type:"state",queuedMessages:[],capabilities },{ type:"run_state",runState }];
}

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, HTMLButtonElement: dom.window.HTMLButtonElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, WebSocket: TestWebSocket, getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  Object.assign(globalThis, { ResizeObserver: class { observe() {} disconnect() {} } });
}
