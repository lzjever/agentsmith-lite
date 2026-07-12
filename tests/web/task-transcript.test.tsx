import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { TaskTranscript } = await import("../../src/components/tasks/TaskTranscript.js");

const originalStream = apiClient.streamTaskTranscript;
afterEach(() => { cleanup(); apiClient.streamTaskTranscript = originalStream; });

describe("task transcript", () => {
  it("renders disconnected and recovered states while preserving streamed messages", async () => {
    let attempts = 0;
    apiClient.streamTaskTranscript = async (_taskId, _cursor, _signal, onEntry, onCursor) => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(503, "Transcript tail unavailable");
      onEntry({ id: "entry_1", taskId: "task_1", role: "assistant", text: "Recovered response", cursor: "cursor-1", eventKind: "assistant_message", createdAt: "2026-07-12T00:00:00.000Z" });
      onCursor("cursor-1");
    };

    render(<TaskTranscript taskId="task_1" />);
    assert.match((await screen.findByRole("alert")).textContent ?? "", /Transcript tail unavailable/);
    assert.ok(screen.getByText("Disconnected"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    assert.ok(await screen.findByText("Recovered response"));
    assert.ok(screen.getByText("Recovered"));
    assert.equal(attempts, 2);
  });
});

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, Element: dom.window.Element, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, self: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
}
