import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import React from "react";
import { apiClient, type Workspace, type WorkspaceMember } from "../../src/lib/api/client.js";

installDom();
const { cleanup, render, screen } = await import("@testing-library/react");
const { WorkspaceOverviewPage } = await import("../../src/components/workspaces/WorkspaceOverviewPage.js");
const { ShellNavigation } = await import("../../src/components/app-shell/Sidebar.js");
const { TooltipProvider } = await import("../../src/components/ui/tooltip.js");

const workspace: Workspace = { id: "ws_1", name: "Design systems", ownerUserId: "owner_1", lifecycleStatus: "archived", capabilities: { canCreateProject: true, canManageMembers: true }, projects: [{ id: "proj_1", workspaceId: "ws_1", name: "Console", lifecycleStatus: "archived", taskConcurrencyLimit: 2, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }], createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" };
const owner: WorkspaceMember = { workspaceId: "ws_1", userId: "owner_1", role: "owner", displayName: "Alex Owner", email: "alex@example.test", createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" };
afterEach(() => cleanup());

describe("workspace overview", () => {
  it("renders workspace metadata, projects, and workspace tools without a project dashboard", async () => {
    const original = { workspaces: apiClient.workspaces, workspaceMembers: apiClient.workspaceMembers }; apiClient.workspaces = async () => [workspace]; apiClient.workspaceMembers = async () => [owner];
    try { render(<AppRouterContext.Provider value={router()}><WorkspaceOverviewPage workspaceId={workspace.id} /></AppRouterContext.Provider>); await screen.findAllByRole("heading", { name: workspace.name }); assert.ok(screen.getByText("Manage workspace")); assert.ok(screen.getByText("Alex Owner")); assert.ok(screen.getByText("alex@example.test")); assert.ok(screen.getAllByText("Archived").length >= 2); assert.equal(screen.queryByText("owner_1"), null); assert.ok(screen.getByRole("link", { name: /Open context/ })); assert.ok(screen.getByRole("link", { name: /Manage members/ })); assert.ok(screen.getByRole("link", { name: /Open settings/ })); assert.ok(screen.getByRole("button", { name: "New project" })); assert.equal(screen.queryByText("Project overview"), null); } finally { apiClient.workspaces = original.workspaces; apiClient.workspaceMembers = original.workspaceMembers; }
  });
  it("states read-only access and hides management calls to action", async () => {
    const original = { workspaces: apiClient.workspaces, workspaceMembers: apiClient.workspaceMembers }; apiClient.workspaces = async () => [{ ...workspace, capabilities: { canCreateProject: false, canManageMembers: false } }]; apiClient.workspaceMembers = async () => [owner];
    try { render(<AppRouterContext.Provider value={router()}><WorkspaceOverviewPage workspaceId={workspace.id} /></AppRouterContext.Provider>); await screen.findByText(/read-only/); assert.equal(screen.queryByRole("button", { name: "New project" }), null); assert.ok(screen.getByRole("link", { name: /View settings/ })); assert.ok(screen.getByText("View workspace metadata. Changes require owner or admin access.")); assert.ok(screen.getByRole("link", { name: /View members/ })); } finally { apiClient.workspaces = original.workspaces; apiClient.workspaceMembers = original.workspaceMembers; }
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
function installDom() { const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" }); Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Document: dom.window.Document, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true }); Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator }); Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent }); if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } }); }
