import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import type { Task, TaskDetail, TaskListPage } from "../../src/lib/api/client.js";
import { taskDetailNeedsRefresh, taskProjectionLabel } from "../../src/components/tasks/task-ui.js";

installDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { TaskList } = await import("../../src/components/tasks/TaskList.js");

afterEach(() => cleanup());

const task = (id: string): Task => ({ id, workspaceId:"workspace_1", projectId:"project_1", endpointId:"endpoint_1", fileLibraryId:`library_${id}`, prompt:id === "task_1" ? "Prepare release notes" : "Incorporate review", status:"running", runId:`run_${id}`, executionMode:"live", sandbox:{ namespace:"agentsmith" }, createdAt:"2026-07-12T00:00:00.000Z", updatedAt:"2026-07-12T00:01:00.000Z" });

describe("task list model", () => {
  it("renders each Task directly without successor or finalization semantics", () => {
    render(<TaskList page={{ items:[listed(task("task_1")), listed(task("task_2"), { currentTurn:{ state:"queued" } })], total:2, nextCursor:null } as TaskListPage} basePath="/workspaces/workspace_1/projects/project_1/tasks" query={{ archived:"exclude", sort:"updated_at", direction:"desc", limit:25 }} pageIndex={0} onQueryChange={() => undefined} onNext={() => undefined} onPrevious={() => undefined} />);

    assert.ok(screen.getByText("Prepare release notes"));
    assert.ok(screen.getByText("Incorporate review"));
    assert.ok(screen.getByText("Ready"));
    assert.ok(screen.getByText("Message queued"));
    assert.equal(screen.queryByText(/successor|finaliz/i), null);
    assert.equal(screen.queryByRole("combobox", { name:"Task status" }), null);
  });

  it("uses only the detail projection for reusable turn and sandbox presentation", () => {
    const ready = detail({ currentTurn:{ state:"ready" }, sandboxState:{ state:"active", runId:"run_1" } });
    const queued = detail({ currentTurn:{ state:"queued" }, sandboxState:{ state:"active", runId:"run_1" } });
    const released = detail({ currentTurn:{ state:"ready" }, sandboxState:{ state:"released", runId:"run_1" } });

    assert.equal(taskProjectionLabel(ready), "Ready");
    assert.equal(taskDetailNeedsRefresh(ready), true);
    assert.equal(taskProjectionLabel(queued), "Message queued");
    assert.equal(taskDetailNeedsRefresh(queued), true);
    assert.equal(taskProjectionLabel(released), "Sandbox unavailable");
    assert.equal(taskDetailNeedsRefresh(released), false);
  });
});

function detail(projection: Pick<TaskDetail, "currentTurn" | "sandboxState">): TaskDetail {
  return { task:task("task_1"), lifecycle:{ state:"active" }, capabilities:{ sendMessage:true, editQueuedMessage:false, abortTurn:false, openTerminal:true, releaseSandbox:false, editTask:true, archiveTask:false, deleteTask:false }, ...projection };
}

function listed(value: Task, projection: Partial<Pick<TaskDetail, "lifecycle" | "currentTurn" | "sandboxState">> = {}): TaskListPage["items"][number] {
  return { task:value, lifecycle:{ state:"active" }, currentTurn:{ state:"ready" }, sandboxState:{ state:"active", runId:value.runId }, ...projection };
}

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url:"http://localhost" });
  Object.assign(globalThis, { window:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement, HTMLFormElement:dom.window.HTMLFormElement, Element:dom.window.Element, Document:dom.window.Document, DocumentFragment:dom.window.DocumentFragment, Node:dom.window.Node, self:dom.window, Event:dom.window.Event, CustomEvent:dom.window.CustomEvent, MutationObserver:dom.window.MutationObserver, getComputedStyle:dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT:true });
  Object.defineProperty(globalThis, "navigator", { configurable:true, value:dom.window.navigator });
}
