import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type Task, type TaskCapabilities } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { TaskLifecycleActions } = await import("../../src/components/tasks/TaskLifecycleActions.js");

afterEach(() => cleanup());

describe("TaskLifecycleActions", () => {
  it("keeps rename disabled until the task title changes", async () => {
    const original = apiClient.editTask;
    let edits = 0;
    apiClient.editTask = async () => { edits += 1; return task; };
    try {
      render(<TaskLifecycleActions task={task} capabilities={capabilities} onRefresh={async () => undefined} />);
      fireEvent.pointerDown(screen.getByRole("button", { name:"Task actions" }), { button:0, ctrlKey:false });
      fireEvent.click(await screen.findByRole("menuitem", { name:"Rename" }));
      const input = await screen.findByLabelText("Task title") as HTMLInputElement;
      const save = screen.getByRole("button", { name:"Save title" }) as HTMLButtonElement;

      assert.equal(save.disabled, true);
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      assert.equal(edits, 0);

      fireEvent.change(input, { target:{ value:"Investigate production issue" } });
      assert.equal(save.disabled, false);
      fireEvent.change(input, { target:{ value:" Investigate " } });
      assert.equal(save.disabled, true);
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      assert.equal(edits, 0);
    } finally { apiClient.editTask = original; }
  });

  it("renames a task through the product API and refreshes its server state", async () => {
    const original = apiClient.editTask;
    const edits: Array<{ taskId:string; title:string; key:string }> = [];
    let refreshes = 0;
    apiClient.editTask = async (taskId, title, key) => { edits.push({ taskId, title, key }); return { ...task, title }; };
    try {
      render(<TaskLifecycleActions task={task} capabilities={capabilities} onRefresh={async () => { refreshes += 1; }} />);
      fireEvent.pointerDown(screen.getByRole("button", { name:"Task actions" }), { button:0, ctrlKey:false });
      fireEvent.click(await screen.findByRole("menuitem", { name:"Rename" }));
      const input = await screen.findByLabelText("Task title");
      fireEvent.change(input, { target:{ value:"Investigate production issue" } });
      fireEvent.click(screen.getByRole("button", { name:"Save title" }));
      await waitFor(() => assert.equal(refreshes, 1));
      assert.equal(edits.length, 1);
      assert.equal(edits[0]?.taskId, task.id);
      assert.equal(edits[0]?.title, "Investigate production issue");
      assert.match(edits[0]?.key ?? "", /^web-task-edit-/);
    } finally { apiClient.editTask = original; }
  });

  it("refreshes the parent when a lifecycle mutation discovers the task is gone", async () => {
    const original = apiClient.editTask;
    let refreshes = 0;
    apiClient.editTask = async () => { throw new ApiError(404, "Task not found"); };
    try {
      render(<TaskLifecycleActions task={task} capabilities={capabilities} onRefresh={async () => { refreshes += 1; }} />);
      fireEvent.pointerDown(screen.getByRole("button", { name: "Task actions" }), { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
      fireEvent.change(await screen.findByLabelText("Task title"), { target: { value: "Missing task" } });
      fireEvent.click(screen.getByRole("button", { name: "Save title" }));

      await waitFor(() => assert.equal(refreshes, 1));
    } finally { apiClient.editTask = original; }
  });

  it("uses a new rename key after a definitive API failure", async () => {
    const original = apiClient.editTask;
    const keys: string[] = [];
    let refreshes = 0;
    apiClient.editTask = async (_taskId, title, key) => {
      keys.push(key);
      if (keys.length === 1) throw new ApiError(409, "Task changed while renaming");
      return { ...task, title };
    };
    try {
      render(<TaskLifecycleActions task={task} capabilities={capabilities} onRefresh={async () => { refreshes += 1; }} />);
      fireEvent.pointerDown(screen.getByRole("button", { name: "Task actions" }), { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
      fireEvent.change(await screen.findByLabelText("Task title"), { target: { value: "Recovered title" } });
      fireEvent.click(screen.getByRole("button", { name: "Save title" }));
      await screen.findByText("Task changed while renaming");

      fireEvent.click(screen.getByRole("button", { name: "Save title" }));
      await waitFor(() => assert.equal(refreshes, 1));
      assert.equal(keys.length, 2);
      assert.notEqual(keys[0], keys[1]);
    } finally { apiClient.editTask = original; }
  });

  it("does not expose removed retry or duplicate actions", async () => {
    render(<TaskLifecycleActions task={task} capabilities={capabilities} onRefresh={async () => undefined} />);
    fireEvent.pointerDown(screen.getByRole("button", { name:"Task actions" }), { button:0, ctrlKey:false });
    await screen.findByRole("menuitem", { name:"Rename" });
    assert.equal(screen.queryByRole("menuitem", { name:"Retry" }), null);
    assert.equal(screen.queryByRole("menuitem", { name:"Duplicate" }), null);
  });

  it("does not expose lifecycle actions without a server capability", () => {
    render(<TaskLifecycleActions task={task} capabilities={{ ...capabilities, editTask:false }} onRefresh={async () => undefined} />);
    assert.equal(screen.queryByRole("button", { name:"Task actions" }), null);
  });

  it("describes archived task retention in terms of File Library files", async () => {
    render(<TaskLifecycleActions task={task} capabilities={{ ...capabilities, archiveTask:true }} onRefresh={async () => undefined} />);
    fireEvent.pointerDown(screen.getByRole("button", { name:"Task actions" }), { button:0,ctrlKey:false });
    fireEvent.click(await screen.findByRole("menuitem", { name:"Archive" }));
    assert.ok(screen.getByText(/File Library files/));
    assert.equal(screen.queryByText(/inputs/), null);
  });
});

const capabilities: TaskCapabilities = { sendMessage:true, editQueuedMessage:false, abortTurn:false, cancelTask:true, openTerminal:true, editTask:true, archiveTask:false, deleteTask:false };
const task: Task = { id:"task_1", workspaceId:"workspace_1", projectId:"project_1", endpointId:"endpoint_1", fileLibraryId:"library_1", title:"Investigate", prompt:"Inspect the workspace", status:"running", runId:"run_1", executionMode:"live", sandbox:{ namespace:"task-1" }, createdAt:"2026-07-16T00:00:00.000Z", updatedAt:"2026-07-16T00:00:00.000Z" };

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url:"http://localhost" });
  Object.assign(globalThis, { window:dom.window, self:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement, HTMLInputElement:dom.window.HTMLInputElement, HTMLFormElement:dom.window.HTMLFormElement, HTMLButtonElement:dom.window.HTMLButtonElement, Element:dom.window.Element, Document:dom.window.Document, DocumentFragment:dom.window.DocumentFragment, Node:dom.window.Node, NodeFilter:dom.window.NodeFilter, Event:dom.window.Event, CustomEvent:dom.window.CustomEvent, MutationObserver:dom.window.MutationObserver, getComputedStyle:dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT:true });
  Object.assign(dom.window, { PointerEvent:dom.window.MouseEvent });
  Object.defineProperty(globalThis, "navigator", { configurable:true, value:dom.window.navigator });
}
