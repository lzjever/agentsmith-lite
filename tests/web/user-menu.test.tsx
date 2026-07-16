import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { apiClient } from "../../src/lib/api/client.js";
import { toast } from "../../src/components/ui/toast.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { UserMenu } = await import("../../src/components/app-shell/UserMenu.js");

afterEach(() => cleanup());

describe("user menu sign out", () => {
  it("serializes sign out attempts and lets the user retry after a failure", async () => {
    const originalLogout = apiClient.logout;
    const originalError = toast.error;
    const errors: string[] = [];
    let attempts = 0;
    let rejectFirst!: (reason: Error) => void;
    apiClient.logout = async () => {
      attempts += 1;
      if (attempts === 1) return new Promise((_, reject) => { rejectFirst = reject; });
      return new Promise(() => {});
    };
    toast.error = (message) => { errors.push(message); };

    try {
      render(<UserMenu user={{ id: "user_1", email: "owner@example.test" }} workspaceId="workspace_1" />);
      openMenu();
      fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
      assert.equal(attempts, 1);

      openMenu();
      const pendingItem = await screen.findByRole("menuitem", { name: "Signing out..." });
      assert.equal(pendingItem.getAttribute("data-disabled"), "");
      fireEvent.click(pendingItem);
      assert.equal(attempts, 1);

      rejectFirst(new Error("network unavailable"));
      await waitFor(() => assert.deepEqual(errors, ["Sign out failed. Check your connection and try again."]));

      fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
      assert.equal(attempts, 2);
    } finally {
      apiClient.logout = originalLogout;
      toast.error = originalError;
    }
  });
});

function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Open account menu" }), { button: 0, ctrlKey: false });
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/app/" });
  Object.assign(globalThis, {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Document: dom.window.Document,
    DocumentFragment: dom.window.DocumentFragment,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, {
    hasPointerCapture() { return false; },
    setPointerCapture() {},
    releasePointerCapture() {},
    scrollIntoView() {}
  });
}
