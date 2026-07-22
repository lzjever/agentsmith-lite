import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToString } from "react-dom/server";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  DocumentFragment: dom.window.DocumentFragment,
  Node: dom.window.Node,
  self: dom.window,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
  IS_REACT_ACT_ENVIRONMENT: true
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(dom.window, "matchMedia", {
  configurable: true,
  value: globalThis.matchMedia
});

const React = await import("react");
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { Link } = await import("@astryxdesign/core/Link");
const { useToast } = await import("@astryxdesign/core");
const { AppProviders } = await import("../../src/app/providers.js");

test.afterEach(() => cleanup());

test("root providers apply Astryx theme and route Astryx links through Next Link", () => {
  render(
    <AppProviders>
      <Link href="/workspaces/ws_1">Open workspace</Link>
    </AppProviders>
  );

  const link = screen.getByRole("link", { name: "Open workspace" });
  assert.equal(link.getAttribute("href"), "/workspaces/ws_1");
  assert.ok(document.querySelector("[data-astryx-theme]"));
});

test("a server-supplied dark theme renders the same Astryx mode before and after hydration", () => {
  const serverMarkup = renderToString(
    <AppProviders initialThemeMode="dark">
      <p>Theme contract</p>
    </AppProviders>
  );
  assert.match(serverMarkup, /data-theme="dark"/);

  render(
    <AppProviders initialThemeMode="dark">
      <p>Theme contract</p>
    </AppProviders>
  );

  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(document.querySelector("[data-astryx-theme]")?.getAttribute("data-theme"), "dark");
});

test("root providers expose Astryx layers for short-lived confirmations", () => {
  function ConfirmationAction() {
    const toast = useToast();
    return <button onClick={() => toast({ type: "info", body: "Workspace created" })}>Create workspace</button>;
  }

  render(<AppProviders><ConfirmationAction /></AppProviders>);
  fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
  assert.ok(screen.getByText("Workspace created"));
});
