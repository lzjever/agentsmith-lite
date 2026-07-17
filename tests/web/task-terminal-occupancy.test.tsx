import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it, mock } from "node:test";
import React from "react";
import type { TaskCapabilities, TaskInteractionStreamEvent } from "../../src/lib/api/client.js";
import { ApiError, apiClient, type Task, type TaskArtifact } from "../../src/lib/api/client.js";

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
mock.method(Terminal.prototype, "clear", () => undefined);
mock.method(Terminal.prototype, "writeln", () => undefined);
mock.method(Terminal.prototype, "dispose", () => undefined);
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { TaskDetailPage } = await import("../../src/components/tasks/TaskDetailPage.js");
const { TaskTerminalPanel } = await import("../../src/components/tasks/TaskTerminalPanel.js");

afterEach(() => { cleanup(); sockets.length = 0; });

describe("TaskDetailPage terminal occupancy", () => {
  it("shows the retained execution and sandbox summary in task details", async () => {
    const original = { taskDetail: apiClient.taskDetail, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    const continued: Task = { ...task, sourceTaskId:"task_source", cleanupStatus:"pending" };
    apiClient.taskDetail = async () => ({ task: continued, capabilities: available });
    apiClient.taskArtifacts = async () => [];
    apiClient.taskInputs = async () => [];
    apiClient.getTaskInteractions = async () => snapshot(available);
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once:true }));
    };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      await screen.findByRole("region", { name:"Task conversation workspace" });
      fireEvent.click(screen.getByText("Task details"));

      assert.ok(screen.getByText("Live sandbox"));
      assert.ok(screen.getByText(task.endpointId));
      assert.ok(screen.getByText(task.runId));
      assert.ok(screen.getByText(task.sandbox.namespace));
      assert.ok(screen.getByText("Pending"));
      assert.equal(screen.getByRole("link", { name:"task_source" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/tasks/task_source");
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("reconnects while a newly created sandbox is still starting", async () => {
    render(<TaskTerminalPanel taskId="task_starting" />);
    await waitFor(() => assert.equal(sockets.length, 1));

    act(() => { sockets[0]?.onerror?.(); sockets[0]?.onclose?.(); });
    await waitFor(() => assert.equal(sockets.length, 2), { timeout: 2_000 });
    act(() => sockets[1]?.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ op: "ready" }) })));

    assert.ok(await screen.findByText("ready"));
    assert.equal(screen.queryByRole("button", { name: "Reconnect terminal" }), null);
  });

  it("keeps the owner's terminal mounted across occupancy and terminal-state updates until the user leaves", async () => {
    const original = { taskDetail: apiClient.taskDetail, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    let receive: ((event: TaskInteractionStreamEvent) => void) | undefined;
    apiClient.taskDetail = async () => ({ task, capabilities: available });
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
      assert.equal(screen.queryByRole("region", { name: "Task terminal" }), null);
      assert.equal(sockets.length, 0);

      fireEvent.click(terminalTab);
      const ownerTerminal = screen.getByRole("region", { name: "Task terminal" });
      await waitFor(() => assert.equal(sockets.length, 1));

      act(() => { for (const event of stateEvents("running", occupied)) receive?.(event); });
      assert.equal(screen.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected"), "true");
      assert.equal(screen.getByRole("region", { name: "Task terminal" }), ownerTerminal);

      act(() => { for (const event of stateEvents("terminal", occupied)) receive?.(event); });
      assert.equal(screen.getByRole("region", { name: "Task terminal" }), ownerTerminal);
      assert.equal(sockets.length, 1);
      assert.ok(screen.getByText(`Active · ${task.id}`));
      assert.ok(screen.getByText("Task run is complete"));

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
    const original = { taskDetail: apiClient.taskDetail, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions };
    let interactionReads = 0;
    let inputReads = 0;
    const artifact: TaskArtifact = { id: "artifact_1", taskId: task.id, fileId: "file_1", name: "result.txt", bytes: 12, mediaType: "text/plain", createdAt: "2026-07-14T00:01:00.000Z" };
    apiClient.taskDetail = async () => ({ task, capabilities: available });
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

  it("rejects a task projected for a different project before loading child resources", async () => {
    const original = { taskDetail: apiClient.taskDetail, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs };
    let artifactReads = 0;
    const wrongTask = { ...task, workspaceId: "workspace_other", projectId: "project_other" };
    apiClient.taskDetail = async () => ({ task: wrongTask, capabilities: available });
    apiClient.taskArtifacts = async () => { artifactReads += 1; return []; };
    apiClient.taskInputs = async () => [];
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} artifactsOnly />);
      assert.match((await screen.findByRole("alert")).textContent ?? "", /does not belong to this project/i);
      assert.equal(artifactReads, 0);
      assert.equal(screen.queryByText(`Active · ${task.id}`), null);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("keeps the latest task state when an older refresh finishes last", async () => {
    const original = { taskDetail: apiClient.taskDetail, taskArtifacts: apiClient.taskArtifacts };
    const completed: Task = { ...task, status: "completed", terminalReason: "completed", artifactProjectionStatus: "complete", cleanupStatus: "complete", updatedAt: "2026-07-14T00:02:00.000Z" };
    let reads = 0;
    let resolveOlder!: (value: { task: Task; capabilities: TaskCapabilities }) => void;
    apiClient.taskDetail = async () => {
      reads += 1;
      if (reads === 1) return { task, capabilities: available };
      if (reads === 2) return new Promise((resolve) => { resolveOlder = resolve; });
      return { task: completed, capabilities: { ...available, cancelTask: false, openTerminal: false } };
    };
    apiClient.taskArtifacts = async () => [];
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} artifactsOnly />);
      await screen.findByText(`Active · ${task.id}`);
      fireEvent.click(screen.getByRole("button", { name: "Refresh task" }));
      await waitFor(() => assert.equal(reads, 2));
      fireEvent.click(screen.getByRole("button", { name: "Refresh task" }));
      await screen.findByText(`Completed · ${task.id}`);
      await act(async () => { resolveOlder({ task, capabilities: available }); await Promise.resolve(); });
      assert.ok(screen.getByText(`Completed · ${task.id}`));
      assert.equal(screen.queryByText(`Active · ${task.id}`), null);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("keeps conversation readable when artifact and input panels fail", async () => {
    const original = { taskDetail: apiClient.taskDetail, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    apiClient.taskDetail = async () => ({ task, capabilities: available });
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

  it("keeps task lifecycle controls available when conversation loading fails", async () => {
    const original = { taskDetail: apiClient.taskDetail, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions };
    apiClient.taskDetail = async () => ({ task, capabilities: available });
    apiClient.taskArtifacts = async () => [];
    apiClient.taskInputs = async () => [];
    apiClient.getTaskInteractions = async () => { throw new Error("Conversation unavailable"); };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      await screen.findByText("Conversation could not be loaded.");
      assert.ok(screen.getByRole("button", { name: "Cancel task" }));
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("locks competing task actions while a lifecycle mutation is pending", async () => {
    const original = { taskDetail: apiClient.taskDetail, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions, duplicateTask: apiClient.duplicateTask };
    let duplicateStarted = false;
    apiClient.taskDetail = async () => ({ task, capabilities: available });
    apiClient.taskArtifacts = async () => [];
    apiClient.taskInputs = async () => [];
    apiClient.getTaskInteractions = async () => { throw new Error("Conversation unavailable"); };
    apiClient.duplicateTask = async () => {
      duplicateStarted = true;
      return new Promise(() => undefined);
    };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      await screen.findByText("Conversation could not be loaded.");
      fireEvent.pointerDown(screen.getByRole("button", { name: "Task actions" }), { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate" }));
      await waitFor(() => assert.equal(duplicateStarted, true));

      assert.equal((screen.getByRole("button", { name: "Refresh task" }) as HTMLButtonElement).disabled, true);
      assert.equal((screen.getByRole("button", { name: "Task actions" }) as HTMLButtonElement).disabled, true);
      assert.equal((screen.getByRole("button", { name: "Cancel task" }) as HTMLButtonElement).disabled, true);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("closes lifecycle confirmation when streamed capabilities revoke access", async () => {
    const original = { taskDetail: apiClient.taskDetail, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    let receive: ((event: TaskInteractionStreamEvent) => void) | undefined;
    apiClient.taskDetail = async () => ({ task, capabilities: available });
    apiClient.taskArtifacts = async () => [];
    apiClient.taskInputs = async () => [];
    apiClient.getTaskInteractions = async () => snapshot(available);
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal, onEvent) => {
      receive = onEvent;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      fireEvent.click(await screen.findByRole("button", { name: "Cancel task" }));
      assert.ok(screen.getByRole("alertdialog", { name: "Cancel task?" }));
      await waitFor(() => assert.ok(receive));
      act(() => receive?.({ type: "state", queuedMessages: [], capabilities: { ...available, cancelTask: false } }));
      assert.equal(screen.queryByRole("alertdialog", { name: "Cancel task?" }), null);
      assert.equal(screen.queryByRole("button", { name: "Cancel task" }), null);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("removes the cancel action when permission is revoked during cancellation", async () => {
    const original = { taskDetail: apiClient.taskDetail, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions, cancelTask: apiClient.cancelTask };
    let detailReads = 0;
    apiClient.taskDetail = async () => ({ task, capabilities: detailReads++ === 0 ? available : { ...available, cancelTask: false } });
    apiClient.taskArtifacts = async () => [];
    apiClient.taskInputs = async () => [];
    apiClient.getTaskInteractions = async () => { throw new Error("Conversation unavailable"); };
    apiClient.cancelTask = async () => { throw new ApiError(403, "Task cancellation permission was revoked."); };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      fireEvent.click(await screen.findByRole("button", { name: "Cancel task" }));
      await screen.findByRole("alertdialog", { name: "Cancel task?" });
      fireEvent.click(screen.getAllByRole("button", { name: "Cancel task" }).at(-1)!);
      await waitFor(() => assert.equal(detailReads, 2));
      assert.equal(screen.queryByRole("button", { name: "Cancel task" }), null);
      assert.equal(screen.queryByRole("alertdialog", { name: "Cancel task?" }), null);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("does not refresh an old task after cancellation finishes on another task", async () => {
    const original = { taskDetail: apiClient.taskDetail, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions, cancelTask: apiClient.cancelTask };
    const secondTask: Task = { ...task, id: "task_second", title: "Second task", runId: "run_2" };
    let finishCancel: (() => void) | undefined;
    apiClient.taskDetail = async (requestedTaskId) => ({ task: requestedTaskId === task.id ? task : secondTask, capabilities: available });
    apiClient.taskArtifacts = async () => [];
    apiClient.taskInputs = async () => [];
    apiClient.getTaskInteractions = async () => snapshot(available);
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    apiClient.cancelTask = async () => new Promise((resolve) => { finishCancel = () => resolve({ accepted: true }); });
    try {
      const view = render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      fireEvent.click(await screen.findByRole("button", { name: "Cancel task" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Cancel task" }).at(-1)!);
      await waitFor(() => assert.ok(finishCancel));

      view.rerender(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={secondTask.id} />);
      await screen.findByRole("heading", { name: "Second task" });
      await act(async () => finishCancel!());
      assert.ok(screen.getByRole("heading", { name: "Second task" }));
      assert.ok(screen.getByText(`Active · ${secondTask.id}`));
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("keeps the terminal result visible while explaining delayed artifact recovery", async () => {
    const original = { taskDetail: apiClient.taskDetail, taskArtifacts: apiClient.taskArtifacts, taskInputs: apiClient.taskInputs, getTaskInteractions: apiClient.getTaskInteractions, streamTaskInteractions: apiClient.streamTaskInteractions };
    const delayed: Task = { ...task, status:"completed", terminalReason:"completed", artifactProjectionStatus:"failed", artifactProjectionError:"Artifact storage is temporarily unavailable", cleanupStatus:"pending" };
    apiClient.taskDetail = async () => ({ task: delayed, capabilities: { ...available, sendMessage: false, cancelTask: false, openTerminal: false } });
    apiClient.taskArtifacts = async () => [];
    apiClient.taskInputs = async () => [];
    apiClient.getTaskInteractions = async () => ({ ...snapshot({ ...available, sendMessage:false, cancelTask:false, openTerminal:false }), runState:"finalizing" });
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once:true }));
    };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);

      await screen.findByText(`Completed · ${task.id}`);
      assert.ok(screen.getByText("Artifact publishing delayed"));
      assert.ok(screen.getByText("Artifact storage is temporarily unavailable"));
      assert.ok(screen.getByText(/retry automatically/i));
      assert.ok(screen.getByText("Artifacts are not fully available yet."));
    } finally {
      Object.assign(apiClient, original);
    }
  });
});

const available: TaskCapabilities = { sendMessage: true, editQueuedMessage: false, abortTurn: false, cancelTask: true, openTerminal: true, editTask:true, retryTask:false, duplicateTask:true, archiveTask:false, deleteTask: false };
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
