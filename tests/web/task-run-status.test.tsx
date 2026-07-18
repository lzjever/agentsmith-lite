import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import type { TaskCapabilities } from "../../src/lib/api/client.js";

installDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { TaskRunStatus } = await import("../../src/components/tasks/TaskRunStatus.js");

afterEach(() => cleanup());

describe("TaskRunStatus", () => {
  it("uses completed and active run icons that match the server-owned state", () => {
    const view = render(<TaskRunStatus runState="terminal" taskResult={{ status:"completed", terminalReason:"completed" }} capabilities={capabilities} aborting={false} onAbort={async () => undefined} />);
    assert.ok(screen.getByRole("img", { name:"Task complete" }));

    view.rerender(<TaskRunStatus runState="running" capabilities={capabilities} aborting={false} onAbort={async () => undefined} />);
    const active = screen.getByRole("img", { name:"Task in progress" });
    assert.match(active.getAttribute("class") ?? "", /animate-spin/);
  });

  it("does not present a cancelled terminal task as successful", () => {
    render(<TaskRunStatus runState="terminal" taskResult={{ status:"cancelled", terminalReason:"cancelled" }} capabilities={capabilities} aborting={false} onAbort={async () => undefined} />);

    assert.ok(screen.getByRole("img", { name:"Task cancelled" }));
    assert.ok(screen.getByText("Task was cancelled"));
    assert.equal(screen.queryByText("Task run is complete"), null);
  });
});

const capabilities: TaskCapabilities = { sendMessage:true, editQueuedMessage:false, abortTurn:false, cancelTask:false, openTerminal:false, editTask:false, retryTask:false, duplicateTask:false, archiveTask:false, deleteTask:false };

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url:"http://localhost" });
  Object.assign(globalThis, { window:dom.window, self:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement, Element:dom.window.Element, Document:dom.window.Document, DocumentFragment:dom.window.DocumentFragment, Node:dom.window.Node, Event:dom.window.Event, CustomEvent:dom.window.CustomEvent, MutationObserver:dom.window.MutationObserver, getComputedStyle:dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT:true });
  Object.defineProperty(globalThis, "navigator", { configurable:true, value:dom.window.navigator });
}
