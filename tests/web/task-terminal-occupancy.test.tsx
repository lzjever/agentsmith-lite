import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it, mock } from "node:test";
import React from "react";
import type { TaskCapabilities, TaskDetail, TaskInteractionItem, TaskInteractionStreamEvent } from "../../src/lib/api/client.js";
import { ApiError, apiClient, type Task, type TaskArtifact } from "../../src/lib/api/client.js";

const sockets: TestWebSocket[] = [];
class TestWebSocket {
  static readonly OPEN = 1;
  readyState = TestWebSocket.OPEN;
  closed = false;
  readonly sent: string[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code:number; reason:string }) => void) | null = null;
  constructor(_url: string) { sockets.push(this); }
  send(data: string): void { this.sent.push(data); }
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

describe("Phase3 Task workspace", () => {
  it("returns an unavailable task deep link to the project task list", async () => {
    const original = apiClient.taskDetail;
    apiClient.taskDetail = async () => { throw new ApiError(404, "Task not found"); };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId="task_missing" />);
      assert.ok(await screen.findByRole("heading", { name:"Task not found" }));
      assert.equal(screen.getByRole("link", { name:"All tasks" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/tasks");
    } finally { apiClient.taskDetail = original; }
  });

  it("keeps the same Task conversation usable whenever the server projects a ready turn and active sandbox", async () => {
    const original = interactionApis();
    const previousTurnFailed: Task = { ...task, status:"failed", terminalReason:"failed" };
    apiClient.taskDetail = async () => detail({ task:previousTurnFailed, currentTurn:{ state:"ready" } });
    apiClient.taskArtifacts = async () => [];
    apiClient.getTaskInteractions = async () => snapshot(available);
    apiClient.streamTaskInteractions = holdStream;
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      assert.ok(await screen.findByText("Ready for a message"));
      assert.equal((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled, false);
      assert.equal(screen.queryByText(/completed task|failed task|new execution/i), null);
      assert.equal(screen.getByText(`Ready · ${task.id}`).textContent, `Ready · ${task.id}`);
    } finally { Object.assign(apiClient, original); }
  });

  it("shows the server-projected queued message during an active turn", async () => {
    const original = interactionApis();
    const queued = { id:"message_queued", content:"Check the migration too", deliveryStatus:"pending" as const, editable:false, deletable:false, updatedAt:"2026-07-19T00:00:01.000Z" };
    apiClient.taskDetail = async () => detail({ currentTurn:{ state:"queued" } });
    apiClient.taskArtifacts = async () => [];
    apiClient.getTaskInteractions = async () => ({ ...snapshot(available), queuedMessages:[queued] });
    apiClient.streamTaskInteractions = holdStream;
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      assert.ok(await screen.findByText(`Message queued · ${task.id}`));
      assert.ok(await screen.findByText("Check the migration too"));
      assert.equal((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled, false);
    } finally { Object.assign(apiClient, original); }
  });

  it("offers same-Task cold start from a released sandbox while preserving history and File Library access", async () => {
    const original = interactionApis();
    const coldStart = { ...available, sendMessage:true, openTerminal:true, releaseSandbox:false, archiveTask:true, deleteTask:true };
    apiClient.taskDetail = async () => detail({ sandboxState:{ state:"released", runId:task.runId }, capabilities:coldStart });
    apiClient.taskArtifacts = async () => [];
    apiClient.getTaskInteractions = async () => ({ ...snapshot({ ...coldStart, sendMessage:false, openTerminal:false }), runtimeReachability:"unreachable" });
    apiClient.streamTaskInteractions = holdStream;
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      assert.ok(await screen.findByText(`Sandbox released · ${task.id}`));
      const releaseNotice = screen.getByText("Sandbox resources were released. Your next message or opening Terminal starts a new sandbox for this Task. Conversation history and File Library files remain available.").closest("div");
      assert.ok(releaseNotice);
      assert.doesNotMatch(releaseNotice.className, /warning|error/);
      assert.equal(screen.queryByText(/runtime is temporarily unreachable/i), null);
      assert.equal(screen.queryByRole("button", { name:"Retry" }), null);
      const composer = await screen.findByLabelText("Message") as HTMLTextAreaElement;
      assert.equal(composer.disabled, false);
      assert.equal(composer.placeholder, "Message the task");
      const terminalTab = screen.getByRole("tab", { name:"Terminal" }) as HTMLButtonElement;
      assert.equal(terminalTab.disabled, false);
      fireEvent.click(terminalTab);
      assert.ok(screen.getByRole("region", { name:"Task terminal" }));
      fireEvent.click(screen.getByText("Task details"));
      assert.equal(screen.getByRole("link", { name:task.fileLibraryId }).getAttribute("href"), `/workspaces/workspace_1/projects/project_1/files?libraryId=${task.fileLibraryId}`);
    } finally { Object.assign(apiClient, original); }
  });

  it("lets released cold-start capabilities override a stale interaction stream", async () => {
    const original = interactionApis();
    const stale = { ...available, sendMessage:false, openTerminal:false, abortTurn:false };
    const coldStart = { ...available, sendMessage:true, openTerminal:true, abortTurn:false, releaseSandbox:false };
    let detailReads = 0;
    let receive: ((event: TaskInteractionStreamEvent) => void) | undefined;
    apiClient.taskDetail = async () => detailReads++ === 0 ? detail() : detail({ sandboxState:{ state:"released", runId:task.runId }, capabilities:coldStart });
    apiClient.taskArtifacts = async () => [];
    apiClient.getTaskInteractions = async () => snapshot(available);
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal, onEvent) => {
      receive = onEvent;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once:true }));
    };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      assert.equal((await screen.findByLabelText("Message") as HTMLTextAreaElement).disabled, false);
      await waitFor(() => assert.ok(receive));
      act(() => receive?.({ type:"state", queuedMessages:[], capabilities:available }));

      await waitFor(() => assert.ok(screen.getByText(`Sandbox released · ${task.id}`)));
      act(() => receive?.({ type:"state", queuedMessages:[], capabilities:stale }));
      await waitFor(() => {
        assert.equal((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled, false);
        assert.equal((screen.getByRole("tab", { name:"Terminal" }) as HTMLButtonElement).disabled, false);
        assert.equal((screen.getByLabelText("Message") as HTMLTextAreaElement).placeholder, "Message the task");
      });
    } finally { Object.assign(apiClient, original); }
  });

  it("makes archived lifecycle explicit without deriving it from Task status", async () => {
    const original = interactionApis();
    const readOnly = { ...available, sendMessage:false, openTerminal:false, editTask:false, archiveTask:false };
    apiClient.taskDetail = async () => detail({ lifecycle:{ state:"archived" }, capabilities:readOnly });
    apiClient.taskArtifacts = async () => [];
    apiClient.getTaskInteractions = async () => snapshot(readOnly);
    apiClient.streamTaskInteractions = holdStream;
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      assert.ok(await screen.findByText(`Archived · ${task.id}`));
      assert.ok(screen.getByText("This task is archived. Its conversation, files, and artifacts remain available."));
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps an opened Terminal mounted when streamed occupancy removes openTerminal", async () => {
    const original = interactionApis();
    let receive: ((event: TaskInteractionStreamEvent) => void) | undefined;
    apiClient.taskDetail = async () => detail();
    apiClient.taskArtifacts = async () => [];
    apiClient.getTaskInteractions = async () => snapshot(available);
    apiClient.streamTaskInteractions = async (_taskId, _cursor, signal, onEvent) => {
      receive = onEvent;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once:true }));
    };
    try {
      const view = render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      fireEvent.click(await screen.findByRole("tab", { name:"Terminal" }));
      const terminal = screen.getByRole("region", { name:"Task terminal" });
      await waitFor(() => assert.equal(sockets.length, 1));
      act(() => receive?.({ type:"state", queuedMessages:[], capabilities:{ ...available, openTerminal:false } }));
      assert.equal(screen.getByRole("region", { name:"Task terminal" }), terminal);
      assert.equal(sockets[0]?.closed, false);
      view.unmount();
      assert.equal(sockets[0]?.closed, true);
    } finally { Object.assign(apiClient, original); }
  });

  it("loads the artifacts-only view without touching conversation APIs", async () => {
    const original = interactionApis();
    let interactionReads = 0;
    const artifact: TaskArtifact = { id:"artifact_1", taskId:task.id, fileId:"file_1", name:"result.txt", bytes:12, mediaType:"text/plain", createdAt:"2026-07-19T00:01:00.000Z" };
    apiClient.taskDetail = async () => detail();
    apiClient.taskArtifacts = async () => [artifact];
    apiClient.getTaskInteractions = async () => { interactionReads += 1; throw new Error("Conversation unavailable"); };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} artifactsOnly />);
      await screen.findByText("result.txt");
      assert.equal(interactionReads, 0);
      assert.ok(screen.getByRole("link", { name:"Download result.txt" }));
    } finally { Object.assign(apiClient, original); }
  });

  it("shows Release sandbox only from the direct server capability, including for a failed sandbox", async () => {
    const original = interactionApis();
    apiClient.taskDetail = async () => detail({ sandboxState:{ state:"failed", runId:task.runId, message:"Runtime failed" }, capabilities:{ ...available, releaseSandbox:true } });
    apiClient.taskArtifacts = async () => [];
    apiClient.getTaskInteractions = async () => snapshot(available);
    apiClient.streamTaskInteractions = holdStream;
    try {
      const view = render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      assert.ok(await screen.findByRole("button", { name:"Release sandbox" }));
      view.unmount();

      apiClient.taskDetail = async () => detail({ sandboxState:{ state:"released", runId:task.runId }, capabilities:{ ...available, releaseSandbox:false } });
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      await screen.findByText(`Sandbox released · ${task.id}`);
      assert.equal(screen.queryByRole("button", { name:"Release sandbox" }), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("warns before release and cancellation makes no API call", async () => {
    const original = interactionApis();
    let releases = 0;
    apiClient.taskDetail = async () => detail({ capabilities:{ ...available, releaseSandbox:true } });
    apiClient.taskArtifacts = async () => [];
    apiClient.getTaskInteractions = async () => snapshot(available);
    apiClient.streamTaskInteractions = holdStream;
    apiClient.releaseTaskSandbox = async () => { releases += 1; throw new Error("Unexpected release"); };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      fireEvent.click(await screen.findByRole("button", { name:"Release sandbox" }));
      assert.ok(screen.getByRole("heading", { name:"Release sandbox?" }));
      assert.ok(screen.getByText(/stops the sandbox unconditionally and may lose running processes or unsaved information/i));
      fireEvent.click(screen.getByRole("button", { name:"Cancel" }));
      await waitFor(() => assert.equal(screen.queryByRole("heading", { name:"Release sandbox?" }), null));
      assert.equal(releases, 0);
    } finally { Object.assign(apiClient, original); }
  });

  it("deduplicates a pending release and disables sandbox actions before the request resolves", async () => {
    const original = interactionApis();
    const releasingCapabilities = { ...available, sendMessage:false, editQueuedMessage:false, abortTurn:false, openTerminal:false, releaseSandbox:false };
    const permissiveCapabilities = { ...available, sendMessage:true, editQueuedMessage:true, abortTurn:true, releaseSandbox:true };
    const queued = { id:"message_queued", content:"Keep this queued", deliveryStatus:"pending" as const, editable:true, deletable:true, updatedAt:"2026-07-19T00:00:01.000Z" };
    let detailReads = 0;
    let releases = 0;
    let releaseKey = "";
    let resolveRelease: ((receipt: Awaited<ReturnType<typeof apiClient.releaseTaskSandbox>>) => void) | undefined;
    apiClient.taskDetail = async () => detailReads++ === 0
      ? detail({ capabilities:permissiveCapabilities })
      : detail({ currentTurn:{ state:"aborting" }, sandboxState:{ state:"release_requested", runId:task.runId }, capabilities:releasingCapabilities });
    apiClient.taskArtifacts = async () => [];
    apiClient.getTaskInteractions = async () => ({ ...snapshot(permissiveCapabilities), items:[stoppableWork], queuedMessages:[queued] });
    apiClient.streamTaskInteractions = holdStream;
    apiClient.releaseTaskSandbox = async (_taskId, key) => {
      releases += 1;
      releaseKey = key;
      return new Promise((resolve) => { resolveRelease = resolve; });
    };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      const stopButton = await screen.findByRole("button", { name:"Stop current turn" });
      const editQueuedButton = screen.getByRole("button", { name:"Edit queued message" });
      const deleteQueuedButton = screen.getByRole("button", { name:"Delete queued message" });
      const stopWorkButton = screen.getByRole("button", { name:"Stop work" });
      const terminalTab = screen.getByRole("tab", { name:"Terminal" }) as HTMLButtonElement;
      const refreshButton = screen.getByRole("button", { name:"Refresh task" }) as HTMLButtonElement;
      const composer = screen.getByLabelText("Message") as HTMLTextAreaElement;
      fireEvent.click(terminalTab);
      const terminalRegion = await screen.findByRole("region", { name:"Task terminal" });
      fireEvent.click(screen.getByRole("tab", { name:"Conversation" }));
      fireEvent.click(await screen.findByRole("button", { name:"Release sandbox" }));
      const releaseButtons = screen.getAllByRole("button", { name:"Release sandbox" });
      fireEvent.click(releaseButtons.at(-1)!);
      await waitFor(() => assert.equal(releases, 1));
      assert.ok(releaseKey);
      assert.equal((screen.getByRole("button", { name:"Working" }) as HTMLButtonElement).disabled, true);
      fireEvent.click(screen.getByRole("button", { name:"Working" }));
      assert.equal(releases, 1);
      assert.equal(composer.disabled, true);
      assert.equal(terminalTab.disabled, true);
      assert.equal(terminalRegion.isConnected, false);
      assert.equal(refreshButton.disabled, true);
      assert.equal(stopButton.isConnected, false);
      assert.equal(editQueuedButton.isConnected, false);
      assert.equal(deleteQueuedButton.isConnected, false);
      assert.equal(stopWorkButton.isConnected, false);
      assert.equal(screen.queryByRole("button", { name:"Release sandbox" }), null);

      await act(async () => resolveRelease?.({ taskId:task.id, sandboxState:{ state:"release_requested", runId:task.runId }, capabilities:releasingCapabilities }));
      await waitFor(() => assert.equal((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled, true));
      assert.equal((screen.getByRole("tab", { name:"Terminal" }) as HTMLButtonElement).disabled, true);
      assert.equal(screen.queryByRole("button", { name:"Stop current turn" }), null);
      assert.equal(screen.queryByRole("button", { name:"Edit queued message" }), null);
      assert.equal(screen.queryByRole("button", { name:"Delete queued message" }), null);
      assert.equal(screen.queryByRole("button", { name:"Release sandbox" }), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps a failed release confirmation recoverable and retries with its stable idempotency key", async () => {
    const original = interactionApis();
    const keys: string[] = [];
    const recoverableCapabilities = { ...available, abortTurn:true, releaseSandbox:true };
    apiClient.taskDetail = async () => detail({ capabilities:recoverableCapabilities });
    apiClient.taskArtifacts = async () => [];
    apiClient.getTaskInteractions = async () => ({ ...snapshot(recoverableCapabilities), items:[stoppableWork] });
    apiClient.streamTaskInteractions = holdStream;
    apiClient.releaseTaskSandbox = async (_taskId, key) => { keys.push(key); throw new Error("Network unavailable"); };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={task.id} />);
      const composer = await screen.findByLabelText("Message") as HTMLTextAreaElement;
      assert.ok(screen.getByRole("button", { name:"Stop current turn" }));
      assert.ok(screen.getByRole("button", { name:"Stop work" }));
      const terminalTab = screen.getByRole("tab", { name:"Terminal" }) as HTMLButtonElement;
      fireEvent.click(screen.getByRole("button", { name:"Release sandbox" }));
      fireEvent.click(screen.getAllByRole("button", { name:"Release sandbox" }).at(-1)!);
      assert.match((await screen.findByRole("alert")).textContent ?? "", /Sandbox could not be released: Network unavailable/);
      assert.equal(composer.disabled, false);
      assert.ok(screen.getByText("Stop current turn"));
      assert.ok(screen.getByText("Stop work"));
      assert.equal(terminalTab.disabled, false);
      fireEvent.click(screen.getAllByRole("button", { name:"Release sandbox" }).at(-1)!);
      await waitFor(() => assert.equal(keys.length, 2));
      assert.equal(keys[1], keys[0]);
      assert.ok(screen.getByRole("button", { name:"Cancel" }));
    } finally { Object.assign(apiClient, original); }
  });
});

describe("Task Terminal socket", () => {
  it("reconnects while a newly created sandbox is still starting", async () => {
    render(<TaskTerminalPanel taskId="task_starting" />);
    await waitFor(() => assert.equal(sockets.length, 1));
    act(() => { sockets[0]?.onerror?.(); sockets[0]?.onclose?.({ code:1006, reason:"" }); });
    await waitFor(() => assert.equal(sockets.length, 2), { timeout:2_000 });
    act(() => sockets[1]?.onmessage?.(new MessageEvent("message", { data:JSON.stringify({ op:"ready" }) })));
    assert.ok(await screen.findByText("ready"));
  });

  it("requires a manual reconnect after the proxy closes an oversized stream", async () => {
    render(<TaskTerminalPanel taskId="task_buffer_limit" />);
    await waitFor(() => assert.equal(sockets.length, 1));
    act(() => sockets[0]?.onclose?.({ code:1009, reason:"Terminal output buffer exceeded" }));
    assert.equal(screen.getByRole("alert").textContent, "Terminal output buffer exceeded");
    assert.ok(screen.getByRole("button", { name:"Reconnect terminal" }));
  });

  it("stops reconnecting when Terminal access is revoked", async () => {
    render(<TaskTerminalPanel taskId="task_revoked" />);
    await waitFor(() => assert.equal(sockets.length, 1));
    act(() => sockets[0]?.onclose?.({ code:1008, reason:"Task terminal access changed" }));
    assert.equal(screen.getByRole("alert").textContent, "Task terminal access changed");
    assert.equal(sockets.length, 1);
  });
});

function interactionApis() {
  return { taskDetail:apiClient.taskDetail, taskArtifacts:apiClient.taskArtifacts, getTaskInteractions:apiClient.getTaskInteractions, streamTaskInteractions:apiClient.streamTaskInteractions, releaseTaskSandbox:apiClient.releaseTaskSandbox };
}

function detail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return { task, lifecycle:{ state:"active" }, currentTurn:{ state:"running" }, sandboxState:{ state:"active", runId:task.runId }, capabilities:available, ...overrides };
}

function snapshot(capabilities: TaskCapabilities) {
  return { items:[], nextPageCursor:null, hasMoreBefore:false, streamCursor:"cursor_1", historyStatus:"complete" as const, queuedMessages:[], runState:"running" as const, runtimeReachability:"reachable" as const, lastSyncedAt:"2026-07-19T00:00:00.000Z", capabilities };
}

async function holdStream(_taskId: string, _cursor: string | undefined, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once:true }));
}

const available: TaskCapabilities = { sendMessage:true, editQueuedMessage:false, abortTurn:false, openTerminal:true, releaseSandbox:false, editTask:true, archiveTask:false, deleteTask:false };
const stoppableWork: TaskInteractionItem = { id:"work_1", revision:1, taskId:"task_fa832", kind:"background_task", title:"Background work", body:null, contentMode:"full", position:1, occurredAt:"2026-07-19T00:00:00.000Z", updatedAt:"2026-07-19T00:00:00.000Z", executionStatus:"running", deliveryStatus:"delivered", label:"Background work", workSummary:"Processing", result:null, error:null, detailsOmitted:false, canStop:true };
const task: Task = { id:"task_fa832", workspaceId:"workspace_1", projectId:"project_1", endpointId:"endpoint_1", fileLibraryId:"library_1", prompt:"Inspect the workspace", status:"running", runId:"run_1", executionMode:"live", sandbox:{ namespace:"task-f58" }, createdAt:"2026-07-19T00:00:00.000Z", updatedAt:"2026-07-19T00:00:00.000Z" };

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url:"http://localhost" });
  Object.assign(globalThis, { window:dom.window, self:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement, HTMLFormElement:dom.window.HTMLFormElement, HTMLButtonElement:dom.window.HTMLButtonElement, Element:dom.window.Element, Document:dom.window.Document, DocumentFragment:dom.window.DocumentFragment, Node:dom.window.Node, Event:dom.window.Event, CustomEvent:dom.window.CustomEvent, MutationObserver:dom.window.MutationObserver, WebSocket:TestWebSocket, getComputedStyle:dom.window.getComputedStyle, requestAnimationFrame:(callback:FrameRequestCallback) => setTimeout(callback, 0), cancelAnimationFrame:clearTimeout, IS_REACT_ACT_ENVIRONMENT:true });
  Object.defineProperty(globalThis, "navigator", { configurable:true, value:dom.window.navigator });
  Object.assign(dom.window, { PointerEvent:dom.window.MouseEvent });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  Object.assign(globalThis, { ResizeObserver:class { observe() {} disconnect() {} } });
}
