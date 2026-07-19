import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { after, afterEach, describe, it } from "node:test";
import React from "react";
import { type Task, type TaskListPage } from "../../src/lib/api/client.js";

const dom = installDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { TaskList } = await import("../../src/components/tasks/TaskList.js");

afterEach(() => cleanup());
after(() => {
  cleanup();
  dom.window.close();
});

describe("task list controls", () => {
  it("sends search and cursor actions to the server-owned list controller", () => {
    const tasks = [listed(task(9, "Release checklist")), listed(task(10, "Task 10"))];
    const queries: unknown[] = [];
    let next = 0;
    render(<TaskList page={{ items: tasks, total: 10, nextCursor: "cursor-2" }} basePath="/workspaces/ws/projects/project/tasks" query={{ archived: "exclude", sort: "updated_at", direction: "desc", limit: 25 }} pageIndex={0} onQueryChange={(query) => queries.push(query)} onNext={() => { next += 1; }} onPrevious={() => undefined} />);

    assert.equal(screen.getByRole("link", { name: /Release checklist/ }).getAttribute("href"), "/workspaces/ws/projects/project/tasks/task_9");
    assert.equal(screen.getByRole("combobox", { name: "Task archive" }).textContent, "Not archived");
    assert.equal(screen.queryByRole("combobox", { name:"Task status" }), null);
    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "release" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply task search" }));
    assert.deepEqual(queries[0], { archived: "exclude", sort: "updated_at", direction: "desc", limit: 25, search: "release" });
    assert.ok(screen.getByText("Release checklist"), "the component must not apply a second browser-side filter");
    fireEvent.click(screen.getByRole("button", { name: "Next task page" }));
    assert.equal(next, 1);
  });
});

function task(index: number, prompt: string): Task {
  return {
    id: `task_${index}`,
    workspaceId: "ws",
    projectId: "project",
    endpointId: "endpoint",
    fileLibraryId: `library_${index}`,
    prompt,
    status: "completed",
    runId: `run_${index}`,
    executionMode: "live",
    sandbox: { namespace: "agentsmith" },
    createdAt: `2026-07-12T00:${String(index).padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-07-12T00:${String(index).padStart(2, "0")}:00.000Z`
  };
}

function listed(value: Task): TaskListPage["items"][number] {
  return { task:value, lifecycle:{ state:"active" }, currentTurn:{ state:"ready" }, sandboxState:{ state:"active", runId:value.runId } };
}

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLFormElement: dom.window.HTMLFormElement, Element: dom.window.Element, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, self: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(globalThis, { PointerEvent: dom.window.PointerEvent });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  return dom;
}
