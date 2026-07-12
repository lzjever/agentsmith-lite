import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type Workspace, type WorkspaceMember } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { WorkspaceDirectoryPage } = await import("../../src/components/workspaces/WorkspaceDirectoryPage.js");
const { WorkspaceProjectsEntryPage } = await import("../../src/components/workspaces/WorkspaceProjectsEntryPage.js");
const { WorkspaceMembersPage } = await import("../../src/components/workspaces/WorkspaceMembersPage.js");

const timestamp = "2026-07-11T00:00:00.000Z";
const workspace: Workspace = { id: "workspace_1", name: "Workspace", ownerUserId: "owner_1", owner: { displayName: "Owner Person", email: "owner@example.test" }, memberRole: "viewer", projects: [], capabilities: { canCreateProject: false, canManageMembers: false }, createdAt: timestamp, updatedAt: timestamp };
const owner: WorkspaceMember = { workspaceId: workspace.id, userId: "owner_1", role: "owner", displayName: "Owner Person", email: "owner@example.test", createdAt: timestamp, updatedAt: timestamp };

afterEach(() => cleanup());

describe("workspace identity UX", () => {
  it("uses the workspace list projection for owner and current access summaries", async () => {
    const original = apiClient.workspaces;
    apiClient.workspaces = async () => [workspace];
    try {
      const directory = render(<WorkspaceDirectoryPage />);
      await screen.findByText("Owner: Owner Person · Your access: Viewer");
      assert.equal(screen.queryByText("owner_1"), null);
      directory.unmount();
      render(<WorkspaceProjectsEntryPage workspaceId={workspace.id} />);
      await screen.findByText("Owner: Owner Person · Your access: Viewer");
    } finally { apiClient.workspaces = original; }
  });

  it("reloads access after a denied workspace membership mutation and keeps an inline retry", async () => {
    const original = { workspaces: apiClient.workspaces, workspaceMembers: apiClient.workspaceMembers, addWorkspaceMember: apiClient.addWorkspaceMember };
    let workspaceReads = 0;
    apiClient.workspaces = async () => [{ ...workspace, memberRole: "admin", capabilities: { canCreateProject: true, canManageMembers: workspaceReads++ === 0 } }];
    apiClient.workspaceMembers = async () => [owner];
    apiClient.addWorkspaceMember = async () => { throw new ApiError(403, "Workspace access denied."); };
    try {
      render(<WorkspaceMembersPage workspaceId={workspace.id} />);
      await screen.findByRole("button", { name: "Add member" });
      fireEvent.click(screen.getByRole("button", { name: "Add member" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: "member@example.test" } });
      fireEvent.click(screen.getAllByRole("button", { name: "Add member" }).at(-1)!);
      await screen.findByRole("alert");
      await waitFor(() => assert.ok(workspaceReads >= 2));
      assert.ok(screen.getByText("Workspace access denied."));
      assert.ok(screen.getByRole("button", { name: "Retry" }));
      assert.ok(screen.getByText("Your workspace access is read-only."));
      assert.ok(screen.getByText("Owner"));
    } finally { Object.assign(apiClient, original); }
  });

  it("persists a project pin locally for the current workspace", async () => {
    const original = apiClient.workspaces;
    const project = { id: "project_1", workspaceId: workspace.id, name: "Pinned project", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp };
    apiClient.workspaces = async () => [{ ...workspace, projects: [project] }];
    try {
      render(<WorkspaceProjectsEntryPage workspaceId={workspace.id} />);
      const pin = (await screen.findAllByRole("button", { name: "Pin Pinned project" }))[0]!;
      fireEvent.click(pin);
      assert.equal(window.localStorage.getItem(`agentsmith:projects:pinned:${workspace.id}`), JSON.stringify([project.id]));
      assert.ok((await screen.findAllByRole("button", { name: "Unpin Pinned project" })).length > 0);
    } finally { apiClient.workspaces = original; }
  });
});

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, { hasPointerCapture() { return false; }, setPointerCapture() {}, releasePointerCapture() {}, scrollIntoView() {} });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
