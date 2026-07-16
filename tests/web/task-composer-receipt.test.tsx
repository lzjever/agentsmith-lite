import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";

installDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { TaskComposer } = await import("../../src/components/tasks/TaskComposer.js");

afterEach(() => cleanup());

describe("task composer receipts", () => {
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
