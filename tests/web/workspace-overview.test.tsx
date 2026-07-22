import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import React from "react";
import { apiClient, type Workspace } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, render, screen, waitFor } = await import("@testing-library/react");
const { WorkspaceOverviewPage } = await import("../../src/components/workspaces/WorkspaceOverviewPage.js");
const { ShellNavigation } = await import("../../src/components/app-shell/Sidebar.js");
const { TooltipProvider } = await import("../../src/components/ui/tooltip.js");

const workspace: Workspace = { id: "ws_1", name: "Design systems", ownerUserId: "owner_1", owner: { displayName: "Alex Owner", email: "alex@example.test" }, memberRole: "owner", lifecycleStatus: "archived", capabilities: { canCreateProject: false, canManageMembers: false }, projects: [{ id: "proj_1", workspaceId: "ws_1", name: "Console", lifecycleStatus: "archived", taskConcurrencyLimit: 2, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }], createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" };
afterEach(() => cleanup());

describe("workspace overview", () => {
  it("ignores a late overview load after switching workspaces", async () => {
    const original = apiClient.workspaces;
    const second = { ...workspace, id: "ws_2", name: "Second workspace", owner: { displayName: "Second Owner", email: "second@example.test" }, projects: [] };
    let finishFirst!: (value: Workspace[]) => void;
    let reads = 0;
    apiClient.workspaces = async () => ++reads === 1 ? new Promise((resolve) => { finishFirst = resolve; }) : [second];
    try {
      const view = render(<AppRouterContext.Provider value={router()}><WorkspaceOverviewPage workspaceId="ws_1" /></AppRouterContext.Provider>);
      await waitFor(() => assert.equal(reads, 1));
      view.rerender(<AppRouterContext.Provider value={router()}><WorkspaceOverviewPage workspaceId="ws_2" /></AppRouterContext.Provider>);
      await screen.findAllByRole("heading", { name: "Second workspace" });
      await act(async () => finishFirst([workspace]));
      assert.ok(screen.getAllByRole("heading", { name: "Second workspace" }).length > 0);
      assert.equal(screen.queryByText("Design systems"), null);
      assert.ok(screen.getByText("Second Owner"));
    } finally { apiClient.workspaces = original; }
  });

  it("renders the workspace projection when the separate member directory is unavailable", async () => {
    const original = { workspaces: apiClient.workspaces, workspaceMembers: apiClient.workspaceMembers }; apiClient.workspaces = async () => [workspace]; apiClient.workspaceMembers = async () => { throw new Error("Member directory unavailable"); };
    try { render(<AppRouterContext.Provider value={router()}><WorkspaceOverviewPage workspaceId={workspace.id} /></AppRouterContext.Provider>); await screen.findAllByRole("heading", { name: workspace.name }); assert.ok(screen.getByText("View workspace")); assert.ok(screen.getByText("Alex Owner")); assert.ok(screen.getByText("alex@example.test")); assert.ok(screen.getAllByText("Archived").length >= 2); assert.equal(screen.queryByText("owner_1"), null); assert.ok(screen.getByRole("link", { name: /Open context/ })); assert.ok(screen.getByRole("link", { name: /View members/ })); assert.ok(screen.getByRole("link", { name: /Open settings/ })); assert.equal(screen.queryByRole("button", { name: "New project" }), null); assert.equal(screen.queryByText("Project overview"), null); } finally { apiClient.workspaces = original.workspaces; apiClient.workspaceMembers = original.workspaceMembers; }
  });
  it("states read-only access and hides management calls to action", async () => {
    const original = { workspaces: apiClient.workspaces, workspaceMembers: apiClient.workspaceMembers }; apiClient.workspaces = async () => [{ ...workspace, memberRole: "viewer", capabilities: { canCreateProject: false, canManageMembers: false } }];
    try { render(<AppRouterContext.Provider value={router()}><WorkspaceOverviewPage workspaceId={workspace.id} /></AppRouterContext.Provider>); await screen.findByText(/read-only/); assert.equal(screen.queryByRole("button", { name: "New project" }), null); assert.ok(screen.getByRole("link", { name: /View settings/ })); assert.ok(screen.getByText("View workspace metadata. Changes require owner or admin access.")); assert.ok(screen.getByRole("link", { name: /View members/ })); } finally { apiClient.workspaces = original.workspaces; apiClient.workspaceMembers = original.workspaceMembers; }
  });
  it("uses the primary action treatment for a permitted project creation entry point", async () => {
    const original = apiClient.workspaces;
    apiClient.workspaces = async () => [{ ...workspace, lifecycleStatus: "active", capabilities: { canCreateProject: true, canManageMembers: true } }];
    try {
      render(<AppRouterContext.Provider value={router()}><WorkspaceOverviewPage workspaceId={workspace.id} /></AppRouterContext.Provider>);
      const create = await screen.findByRole("button", { name: "New project" });
      assert.equal(create.getAttribute("data-variant"), "primary");
    } finally { apiClient.workspaces = original; }
  });
  it("keeps workspace overview and projects as distinct shell destinations", () => {
    const view = render(<TooltipProvider><ShellNavigation workspace={workspace} pathname="/workspaces/ws_1" /></TooltipProvider>);
    assert.equal(view.getByRole("link", { name: "Overview" }).getAttribute("aria-current"), "page");
    assert.equal(view.getByRole("link", { name: "Projects" }).getAttribute("aria-current"), null);
  });
  it("groups retained project routes by use, develop, and manage without hiding readable pages", () => {
    const view = render(<TooltipProvider><ShellNavigation workspace={workspace} project={workspace.projects[0]!} pathname="/workspaces/ws_1/projects/proj_1/overview" /></TooltipProvider>);
    assert.ok(view.getByText("Use")); assert.ok(view.getByText("Develop")); assert.ok(view.getByText("Manage"));
    assert.ok(view.getByRole("link", { name: "Credentials" })); assert.ok(view.getByRole("link", { name: "Resource policy" }));
  });
});
function router() { return { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }; }
function installDom() { const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" }); const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number; const matchMedia = () => ({ matches: false, media: "", onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } }); Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Document: dom.window.Document, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame, cancelAnimationFrame: (id: number) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true }); Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator }); Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent, requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, matchMedia }); dom.window.HTMLCanvasElement.prototype.getContext = () => null; if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } }); }
