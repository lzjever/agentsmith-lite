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
  it("renders the server-projected current turn without treating a completed turn as a completed Task", () => {
    const view = render(<TaskRunStatus currentTurn={{ state:"ready" }} sandboxState={{ state:"active", runId:"run_1" }} capabilities={capabilities} aborting={false} onAbort={async () => undefined} />);
    assert.ok(screen.getByRole("img", { name:"Task ready" }));
    assert.ok(screen.getByText("Ready for a message"));

    view.rerender(<TaskRunStatus currentTurn={{ state:"running" }} sandboxState={{ state:"active", runId:"run_1" }} capabilities={capabilities} aborting={false} onAbort={async () => undefined} />);
    const active = screen.getByRole("img", { name:"Task in progress" });
    assert.match(active.getAttribute("class") ?? "", /animate-spin/);
  });

  it("shows queued work and a released sandbox truthfully", () => {
    const view = render(<TaskRunStatus currentTurn={{ state:"queued" }} sandboxState={{ state:"active", runId:"run_1" }} capabilities={capabilities} aborting={false} onAbort={async () => undefined} />);
    assert.ok(screen.getByText("Message queued"));

    view.rerender(<TaskRunStatus currentTurn={{ state:"ready" }} sandboxState={{ state:"released", runId:"run_1" }} capabilities={{ ...capabilities, sendMessage:false }} aborting={false} onAbort={async () => undefined} />);
    assert.ok(screen.getByRole("img", { name:"Sandbox unavailable" }));
    assert.ok(screen.getByText("Sandbox is unavailable"));
  });
});

const capabilities: TaskCapabilities = { sendMessage:true, editQueuedMessage:false, abortTurn:false, openTerminal:false, releaseSandbox:false, editTask:false, archiveTask:false, deleteTask:false };

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url:"http://localhost" });
  Object.assign(globalThis, { window:dom.window, self:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement, Element:dom.window.Element, Document:dom.window.Document, DocumentFragment:dom.window.DocumentFragment, Node:dom.window.Node, Event:dom.window.Event, CustomEvent:dom.window.CustomEvent, MutationObserver:dom.window.MutationObserver, getComputedStyle:dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT:true });
  Object.defineProperty(globalThis, "navigator", { configurable:true, value:dom.window.navigator });
}
