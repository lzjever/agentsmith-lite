import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { describe, it } from "node:test";
import React from "react";

installDom();
const { fireEvent, render, screen } = await import("@testing-library/react");
const { SettingsRouteError, SettingsRouteLoading } = await import("../../src/components/settings/SettingsRouteState.js");

describe("settings route recovery", () => {
  it("uses shared loading and retry states", () => {
    const retries: number[] = [];
    const view = render(<SettingsRouteLoading />);
    assert.ok(screen.getByRole("status"));
    view.unmount();
    window.history.replaceState({}, "", "/workspaces/ws_1/settings");
    render(<SettingsRouteError error={new Error("Workspace settings request timed out.")} reset={() => retries.push(1)} />);
    assert.ok(screen.getByRole("alert").textContent?.includes("Workspace settings request timed out."));
    assert.equal(screen.getByRole("link", { name: "Back" }).getAttribute("href"), "/workspaces/ws_1");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    assert.deepEqual(retries, [1]);
  });
});

function installDom() { const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" }); Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Document: dom.window.Document, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true }); Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator }); Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent }); if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } }); }
