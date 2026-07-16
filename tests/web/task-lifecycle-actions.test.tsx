import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { apiClient, type Task, type TaskCapabilities } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { TaskLifecycleActions } = await import("../../src/components/tasks/TaskLifecycleActions.js");

afterEach(() => cleanup());

describe("TaskLifecycleActions", () => {
  it("renames a task through the product API and refreshes its server state", async () => {
    const original = apiClient.editTask;
    const edits: Array<{ taskId:string; title:string; key:string }> = [];
    let refreshes = 0;
    apiClient.editTask = async (taskId, title, key) => { edits.push({ taskId, title, key }); return { ...task, title }; };
    try {
      render(<TaskLifecycleActions task={task} capabilities={capabilities} basePath="/tasks" onRefresh={async () => { refreshes += 1; }} />);
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

  it("does not expose lifecycle actions without a server capability", () => {
    render(<TaskLifecycleActions task={task} capabilities={{ ...capabilities, editTask:false, duplicateTask:false }} basePath="/tasks" onRefresh={async () => undefined} />);
    assert.equal(screen.queryByRole("button", { name:"Task actions" }), null);
  });
});

const capabilities: TaskCapabilities = { sendMessage:true, editQueuedMessage:false, abortTurn:false, cancelTask:true, openTerminal:true, editTask:true, retryTask:false, duplicateTask:true, archiveTask:false, deleteTask:false };
const task: Task = { id:"task_1", workspaceId:"workspace_1", projectId:"project_1", endpointId:"endpoint_1", title:"Investigate", prompt:"Inspect the workspace", status:"running", runId:"run_1", executionMode:"live", sandbox:{ namespace:"task-1", resources:[] }, createdAt:"2026-07-16T00:00:00.000Z", updatedAt:"2026-07-16T00:00:00.000Z" };

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url:"http://localhost" });
  Object.assign(globalThis, { window:dom.window, self:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement, HTMLInputElement:dom.window.HTMLInputElement, HTMLFormElement:dom.window.HTMLFormElement, HTMLButtonElement:dom.window.HTMLButtonElement, Element:dom.window.Element, Document:dom.window.Document, DocumentFragment:dom.window.DocumentFragment, Node:dom.window.Node, NodeFilter:dom.window.NodeFilter, Event:dom.window.Event, CustomEvent:dom.window.CustomEvent, MutationObserver:dom.window.MutationObserver, getComputedStyle:dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT:true });
  Object.assign(dom.window, { PointerEvent:dom.window.MouseEvent });
  Object.defineProperty(globalThis, "navigator", { configurable:true, value:dom.window.navigator });
}
