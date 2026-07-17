import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";

installDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { TaskComposer } = await import("../../src/components/tasks/TaskComposer.js");

afterEach(() => cleanup());

describe("task composer receipts", () => {
  it("keeps queued message save disabled until the content changes", async () => {
    let updates = 0;
    render(<TaskComposer capabilities={{ sendMessage: true, editQueuedMessage: true, abortTurn: false, cancelTask: false, openTerminal: false, editTask:true, retryTask:false, duplicateTask:true, archiveTask:false, deleteTask: false }} queuedMessages={[{ id:"message_1", content:"Please continue", deliveryStatus:"pending", editable:true, deletable:true, updatedAt:"2026-07-16T00:00:00.000Z" }]} busy={false} onSend={async () => undefined} onUpdateQueued={async () => { updates += 1; }} onDeleteQueued={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name:"Edit queued message" }));
    const editor = await screen.findByRole("textbox", { name:"Queued message" }) as HTMLTextAreaElement;
    const save = screen.getByRole("button", { name:"Save message" }) as HTMLButtonElement;

    assert.equal(save.disabled, true);
    fireEvent.submit(editor.closest("form") as HTMLFormElement);
    assert.equal(updates, 0);

    fireEvent.change(editor, { target:{ value:"Please continue with the review" } });
    assert.equal(save.disabled, false);
    fireEvent.change(editor, { target:{ value:" Please continue " } });
    assert.equal(save.disabled, true);
    fireEvent.submit(editor.closest("form") as HTMLFormElement);
    assert.equal(updates, 0);
  });

  it("retains the draft when the server resolves the mutation with a safe failure", async () => {
    render(<TaskComposer capabilities={{ sendMessage: true, editQueuedMessage: true, abortTurn: false, cancelTask: false, openTerminal: false, editTask:true, retryTask:false, duplicateTask:true, archiveTask:false, deleteTask: false }} queuedMessages={[]} busy={false} onSend={async () => { throw new Error("Delivery is unavailable."); }} onUpdateQueued={async () => undefined} onDeleteQueued={async () => undefined} />);
    const composer = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Please continue" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    assert.match((await screen.findByRole("alert")).textContent ?? "", /Delivery is unavailable/);
    assert.equal(composer.value, "Please continue");
  });
});

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLFormElement: dom.window.HTMLFormElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, self: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
}
