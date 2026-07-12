import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import type { Task, TaskSummary } from "../../src/lib/api/client.js";

installDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { TaskList } = await import("../../src/components/tasks/TaskList.js");

afterEach(() => cleanup());

const task = (id: string, sourceTaskId?: string): Task => ({ id, workspaceId: "workspace_1", projectId: "project_1", endpointId: "endpoint_1", prompt: id === "task_1" ? "Prepare release notes" : "Incorporate review", status: "completed", runId: `run_${id}`, sourceTaskId, executionMode: "live", sandbox: { namespace: "agentsmith", resources: [] }, createdAt: "2026-07-12T00:00:00.000Z", updatedAt: "2026-07-12T00:01:00.000Z" });

describe("task list summaries", () => {
  it("shows server summary counts and source/follow-up relationships", () => {
    const summaries: TaskSummary[] = [{ taskId: "task_1", eventCount: 4, artifactCount: 2, updatedAt: "2026-07-12T00:02:00.000Z" }, { taskId: "task_2", eventCount: 1, artifactCount: 0, updatedAt: "2026-07-12T00:03:00.000Z" }];
    render(<TaskList page={{ items: [task("task_1"), task("task_2", "task_1")], total: 2, nextCursor: null }} summaries={summaries} basePath="/workspaces/workspace_1/projects/project_1/tasks" query={{ archived: "exclude", sort: "updated_at", direction: "desc", limit: 25 }} pageIndex={0} onQueryChange={() => undefined} onNext={() => undefined} onPrevious={() => undefined} />);
    assert.ok(screen.getByText("4 events"));
    assert.ok(screen.getByText("2 artifacts"));
    assert.ok(screen.getByText("1 follow-up"));
    assert.ok(screen.getByText("Follow-up of task_1"));
  });
});

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, self: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
}
