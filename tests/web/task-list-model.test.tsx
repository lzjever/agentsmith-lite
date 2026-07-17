import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import type { Task } from "../../src/lib/api/client.js";
import { taskFinalizationPresentation, taskNeedsRefresh } from "../../src/components/tasks/task-ui.js";

installDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { TaskList } = await import("../../src/components/tasks/TaskList.js");

afterEach(() => cleanup());

const task = (id: string, sourceTaskId?: string): Task => ({ id, workspaceId: "workspace_1", projectId: "project_1", endpointId: "endpoint_1", prompt: id === "task_1" ? "Prepare release notes" : "Incorporate review", status: "completed", runId: `run_${id}`, sourceTaskId, executionMode: "live", sandbox: { namespace: "agentsmith" }, createdAt: "2026-07-12T00:00:00.000Z", updatedAt: "2026-07-12T00:01:00.000Z" });

describe("task list model", () => {
  it("uses task state directly and labels linked executions as successors", () => {
    render(<TaskList page={{ items: [task("task_1"), task("task_2", "task_1")], total: 2, nextCursor: null }} basePath="/workspaces/workspace_1/projects/project_1/tasks" query={{ archived: "exclude", sort: "updated_at", direction: "desc", limit: 25 }} pageIndex={0} onQueryChange={() => undefined} onNext={() => undefined} onPrevious={() => undefined} />);
    assert.ok(screen.getByText("Successor of task_1"));
    assert.equal(screen.queryByText(/events/i), null);
  });

  it("keeps the task result primary while showing delayed finalization", () => {
    const delayed: Task = {
      ...task("task_1"),
      terminalReason: "completed",
      artifactProjectionStatus: "failed",
      artifactProjectionError: "Artifact storage is temporarily unavailable",
      cleanupStatus: "pending"
    };

    render(<TaskList page={{ items: [delayed], total: 1, nextCursor: null }} basePath="/workspaces/workspace_1/projects/project_1/tasks" query={{ archived: "exclude", sort: "updated_at", direction: "desc", limit: 25 }} pageIndex={0} onQueryChange={() => undefined} onNext={() => undefined} onPrevious={() => undefined} />);

    assert.ok(screen.getByText("Completed"));
    assert.ok(screen.getByText("Finalization needs attention"));
  });

  it("refreshes through cleanup recovery and stops after app-owned resources are removed", () => {
    const delayed: Task = { ...task("task_1"), terminalReason:"completed", artifactProjectionStatus:"drained", cleanupStatus:"failed", cleanupError:"Sandbox deletion is temporarily unavailable" };
    const completed: Task = { ...delayed, cleanupStatus:"completed", cleanupError:null };

    assert.deepEqual(taskFinalizationPresentation(delayed), {
      label:"Sandbox cleanup delayed",
      description:"App-owned sandbox resources are not yet confirmed removed. AgentSmith will retry automatically.",
      error:"Sandbox deletion is temporarily unavailable",
      tone:"warning"
    });
    assert.equal(taskNeedsRefresh(delayed), true);
    assert.equal(taskFinalizationPresentation(completed), null);
    assert.equal(taskNeedsRefresh(completed), false);
  });
});

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, self: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
}
