import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import React from "react";
import { ApiError, apiClient, type ProjectSettings, type WorkspaceSettings } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { ProjectSettingsPage } = await import("../../src/components/settings/ProjectSettingsPage.js");
const { WorkspaceSettingsPage } = await import("../../src/components/settings/WorkspaceSettingsPage.js");

afterEach(() => cleanup());

const projectSettings: ProjectSettings = { project: { id: "project_1", workspaceId: "workspace_1", ownerUserId: "owner_1", name: "Project Alpha", taskConcurrencyLimit: 2, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }, workspaceLifecycleStatus: "active", capabilities: { canManageSettings: true } };
const workspaceSettings: WorkspaceSettings = { workspace: { id: "workspace_1", ownerUserId: "owner_1", name: "Workspace Alpha", projects: [], capabilities: { canCreateProject: true, canManageMembers: true }, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }, capabilities: { canManageSettings: true } };

describe("settings deletion", () => {
  it("explains when project settings are read-only because the workspace is archived", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity };
    apiClient.projectSettings = async () => ({ ...projectSettings, workspaceLifecycleStatus: "archived", capabilities: { canManageSettings: false } });
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    try {
      render(<AppRouterContext.Provider value={router([])}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      await screen.findByText("This project is read-only because its workspace is archived.");
      assert.equal((screen.getByRole("textbox", { name: "Project name" }) as HTMLInputElement).disabled, true);
    } finally { Object.assign(apiClient, original); }
  });

  it("requires restoring the workspace before an archived project can be restored", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity, members: apiClient.members };
    apiClient.projectSettings = async () => ({ ...projectSettings, project: { ...projectSettings.project, lifecycleStatus: "archived" }, workspaceLifecycleStatus: "archived", capabilities: { canManageSettings: false } });
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.members = async () => [];
    try {
      render(<AppRouterContext.Provider value={router([])}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      await screen.findByText("Restore the workspace before unarchiving this project.");
      assert.equal(screen.queryByRole("button", { name: "Unarchive project" }), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("refreshes project settings when a stale save discovers the project is archived", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity, updateProjectSettings: apiClient.updateProjectSettings };
    let loads = 0;
    apiClient.projectSettings = async () => ({
      ...projectSettings,
      project: { ...projectSettings.project, lifecycleStatus: loads++ === 0 ? "active" : "archived" },
      capabilities: { canManageSettings: loads === 1 },
    });
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.updateProjectSettings = async () => { throw new ApiError(409, "Project is archived"); };
    try {
      render(<AppRouterContext.Provider value={router([])}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      const name = await screen.findByRole("textbox", { name: "Project name" });
      fireEvent.change(name, { target: { value: "Stale rename" } });
      fireEvent.click(screen.getByRole("button", { name: "Save project" }));

      await screen.findByText("This project is archived and read-only.");
      assert.equal((screen.getByRole("textbox", { name: "Project name" }) as HTMLInputElement).disabled, true);
      assert.equal(screen.queryByRole("button", { name: "Save project" }), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("refreshes workspace settings when a stale save discovers access was revoked", async () => {
    const original = { workspaceSettings: apiClient.workspaceSettings, currentIdentity: apiClient.currentIdentity, updateWorkspaceSettings: apiClient.updateWorkspaceSettings };
    let loads = 0;
    apiClient.workspaceSettings = async () => ({
      ...workspaceSettings,
      capabilities: { canManageSettings: loads++ === 0 },
    });
    apiClient.currentIdentity = async () => ({ user: { id: "admin_1", email: "admin@example.test" } });
    apiClient.updateWorkspaceSettings = async () => { throw new ApiError(403, "Workspace access denied"); };
    try {
      render(<AppRouterContext.Provider value={router([])}><WorkspaceSettingsPage workspaceId="workspace_1" /></AppRouterContext.Provider>);
      const name = await screen.findByRole("textbox", { name: "Workspace name" });
      fireEvent.change(name, { target: { value: "Stale rename" } });
      fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));

      await screen.findByText("Read-only access.");
      assert.equal((screen.getByRole("textbox", { name: "Workspace name" }) as HTMLInputElement).disabled, true);
      assert.equal(screen.queryByRole("button", { name: "Save workspace" }), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("closes ownership confirmation when the selected member is no longer eligible", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity, members: apiClient.members, transferProjectOwner: apiClient.transferProjectOwner };
    let memberReads = 0;
    apiClient.projectSettings = async () => projectSettings;
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.members = async () => {
      memberReads += 1;
      const owner = { projectId: "project_1", userId: "owner_1", role: "owner" as const, displayName: "Owner Person", email: "owner@example.test", createdAt: projectSettings.project.createdAt, updatedAt: projectSettings.project.updatedAt };
      const member = { projectId: "project_1", userId: "member_1", role: "member" as const, displayName: "Member Person", email: "member@example.test", createdAt: projectSettings.project.createdAt, updatedAt: projectSettings.project.updatedAt };
      return memberReads === 1 ? [owner, member] : [owner];
    };
    apiClient.transferProjectOwner = async () => { throw new ApiError(409, "Target must be a different existing project member"); };
    try {
      render(<AppRouterContext.Provider value={router([])}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      fireEvent.click(await screen.findByRole("combobox", { name: "New project owner" }));
      fireEvent.click(await screen.findByRole("option", { name: "Member Person" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Transfer ownership" })[0]!);
      fireEvent.click((await screen.findAllByRole("button", { name: "Transfer ownership" })).at(-1)!);

      await waitFor(() => assert.equal(memberReads, 2));
      await waitFor(() => assert.equal(screen.queryByRole("alertdialog", { name: "Transfer project ownership" }), null));
      assert.ok(screen.getByText("There are no other project members eligible to become owner."));
    } finally { Object.assign(apiClient, original); }
  });

  it("restores editable settings after an owner unarchives a project or workspace", async () => {
    const original = { projectSettings: apiClient.projectSettings, workspaceSettings: apiClient.workspaceSettings, currentIdentity: apiClient.currentIdentity, members: apiClient.members, workspaceMembers: apiClient.workspaceMembers, unarchiveProject: apiClient.unarchiveProject, unarchiveWorkspace: apiClient.unarchiveWorkspace };
    let projectArchived = true;
    let workspaceArchived = true;
    apiClient.projectSettings = async () => ({ ...projectSettings, project: { ...projectSettings.project, lifecycleStatus: projectArchived ? "archived" : "active" }, capabilities: { canManageSettings: !projectArchived } });
    apiClient.workspaceSettings = async () => ({ ...workspaceSettings, workspace: { ...workspaceSettings.workspace, lifecycleStatus: workspaceArchived ? "archived" : "active" }, capabilities: { canManageSettings: !workspaceArchived } });
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.members = async () => [];
    apiClient.workspaceMembers = async () => [];
    apiClient.unarchiveProject = async () => { projectArchived = false; return { ...projectSettings.project, lifecycleStatus: "active" }; };
    apiClient.unarchiveWorkspace = async () => { workspaceArchived = false; return { ...workspaceSettings.workspace, lifecycleStatus: "active" }; };
    try {
      const project = render(<AppRouterContext.Provider value={router([])}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      const unarchiveProject = await screen.findByRole("button", { name: "Unarchive project" });
      await act(async () => fireEvent.click(unarchiveProject));
      assert.equal((screen.getByRole("textbox", { name: "Project name" }) as HTMLInputElement).disabled, false);
      assert.ok(screen.getByRole("button", { name: "Save project" }));

      project.unmount();
      render(<AppRouterContext.Provider value={router([])}><WorkspaceSettingsPage workspaceId="workspace_1" /></AppRouterContext.Provider>);
      const unarchiveWorkspace = await screen.findByRole("button", { name: "Unarchive workspace" });
      await act(async () => fireEvent.click(unarchiveWorkspace));
      assert.equal((screen.getByRole("textbox", { name: "Workspace name" }) as HTMLInputElement).disabled, false);
      assert.ok(screen.getByRole("button", { name: "Save workspace" }));
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps project deletion owner-only, requires its name, and retries a pending cleanup", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity, deleteProject: apiClient.deleteProject };
    const pushed: string[] = [];
    let attempts = 0;
    apiClient.projectSettings = async () => projectSettings;
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.deleteProject = async () => { attempts += 1; if (attempts === 1) throw new ApiError(409, "Project deletion is still pending"); return { deleted: true }; };
    try {
      render(<AppRouterContext.Provider value={router(pushed)}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      await screen.findByRole("button", { name: "Open project deletion confirmation" });
      fireEvent.click(screen.getByRole("button", { name: "Open project deletion confirmation" }));
      const confirm = await screen.findByRole("button", { name: "Delete project" });
      assert.equal((confirm as HTMLButtonElement).disabled, true);
      fireEvent.change(screen.getByRole("textbox", { name: "Project name confirmation" }), { target: { value: "Project Alpha" } });
      await waitFor(() => assert.equal((screen.getByRole("button", { name: "Delete project" }) as HTMLButtonElement).disabled, false));
      fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
      await screen.findByRole("alert");
      assert.match(screen.getByRole("alert").textContent ?? "", /Deletion is pending/);
      fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
      await waitFor(() => assert.deepEqual(pushed, ["/workspaces/workspace_1"]));
      assert.equal(attempts, 2);
    } finally {
      apiClient.projectSettings = original.projectSettings;
      apiClient.currentIdentity = original.currentIdentity;
      apiClient.deleteProject = original.deleteProject;
    }
  });

  it("returns to the workspace when ownership changes during project deletion", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity, members: apiClient.members, deleteProject: apiClient.deleteProject };
    const pushed: string[] = [];
    let revoked = false;
    apiClient.projectSettings = async () => ({ ...projectSettings, project: { ...projectSettings.project, ownerUserId: revoked ? "owner_2" : "owner_1" } });
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.members = async () => [];
    apiClient.deleteProject = async () => { revoked = true; throw new ApiError(403, "Project owner access required"); };
    try {
      render(<AppRouterContext.Provider value={router(pushed)}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      fireEvent.click(await screen.findByRole("button", { name: "Open project deletion confirmation" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Project name confirmation" }), { target: { value: "Project Alpha" } });
      fireEvent.click(screen.getByRole("button", { name: "Delete project" }));

      await waitFor(() => assert.deepEqual(pushed, ["/workspaces/workspace_1"]));
      await waitFor(() => assert.equal(screen.queryByRole("alertdialog", { name: "Delete project" }), null));
    } finally { Object.assign(apiClient, original); }
  });

  it("returns to the workspace when project deletion discovers the project is already gone", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity, members: apiClient.members, deleteProject: apiClient.deleteProject };
    const pushed: string[] = [];
    apiClient.projectSettings = async () => projectSettings;
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.members = async () => [];
    apiClient.deleteProject = async () => { throw new ApiError(404, "Project not found"); };
    try {
      render(<AppRouterContext.Provider value={router(pushed)}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      fireEvent.click(await screen.findByRole("button", { name: "Open project deletion confirmation" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Project name confirmation" }), { target: { value: "Project Alpha" } });
      fireEvent.click(screen.getByRole("button", { name: "Delete project" }));

      await waitFor(() => assert.deepEqual(pushed, ["/workspaces/workspace_1"]));
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps a deletion continuation available after the page reloads in deleting state", async () => {
    const original = { projectSettings: apiClient.projectSettings, workspaceSettings: apiClient.workspaceSettings, currentIdentity: apiClient.currentIdentity };
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.projectSettings = async () => ({ ...projectSettings, project: { ...projectSettings.project, lifecycleStatus: "deleting" } });
    apiClient.workspaceSettings = async () => ({ ...workspaceSettings, workspace: { ...workspaceSettings.workspace, lifecycleStatus: "deleting" } });
    try {
      const project = render(<AppRouterContext.Provider value={router([])}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      assert.ok(await screen.findByRole("button", { name: "Continue project deletion" }));
      project.unmount();
      render(<AppRouterContext.Provider value={router([])}><WorkspaceSettingsPage workspaceId="workspace_1" /></AppRouterContext.Provider>);
      assert.ok(await screen.findByRole("button", { name: "Continue workspace deletion" }));
    } finally { Object.assign(apiClient, original); }
  });

  it("does not navigate when deletion finishes after switching projects", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity, deleteProject: apiClient.deleteProject };
    const pushed: string[] = [];
    let finishDelete: (() => void) | undefined;
    apiClient.projectSettings = async (requestedProjectId) => ({
      ...projectSettings,
      project: {
        ...projectSettings.project,
        id: requestedProjectId,
        workspaceId: requestedProjectId === "project_1" ? "workspace_1" : "workspace_2",
        name: requestedProjectId === "project_1" ? "Project Alpha" : "Project Beta",
      },
    });
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.deleteProject = async () => new Promise((resolve) => { finishDelete = () => resolve({ deleted: true }); });
    try {
      const view = render(<AppRouterContext.Provider value={router(pushed)}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      fireEvent.click(await screen.findByRole("button", { name: "Open project deletion confirmation" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Project name confirmation" }), { target: { value: "Project Alpha" } });
      fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
      await waitFor(() => assert.ok(finishDelete));

      view.rerender(<AppRouterContext.Provider value={router(pushed)}><ProjectSettingsPage workspaceId="workspace_2" projectId="project_2" /></AppRouterContext.Provider>);
      assert.equal((await screen.findByRole("textbox", { name: "Project name" }) as HTMLInputElement).value, "Project Beta");
      await act(async () => finishDelete!());
      assert.deepEqual(pushed, []);
      assert.equal((screen.getByRole("textbox", { name: "Project name" }) as HTMLInputElement).value, "Project Beta");
    } finally { Object.assign(apiClient, original); }
  });

  it("does not navigate when deletion finishes after switching workspaces", async () => {
    const original = { workspaceSettings: apiClient.workspaceSettings, currentIdentity: apiClient.currentIdentity, deleteWorkspace: apiClient.deleteWorkspace };
    const pushed: string[] = [];
    let finishDelete: (() => void) | undefined;
    apiClient.workspaceSettings = async (requestedWorkspaceId) => ({
      ...workspaceSettings,
      workspace: {
        ...workspaceSettings.workspace,
        id: requestedWorkspaceId,
        name: requestedWorkspaceId === "workspace_1" ? "Workspace Alpha" : "Workspace Beta",
      },
    });
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.deleteWorkspace = async () => new Promise((resolve) => { finishDelete = () => resolve({ deleted: true }); });
    try {
      const view = render(<AppRouterContext.Provider value={router(pushed)}><WorkspaceSettingsPage workspaceId="workspace_1" /></AppRouterContext.Provider>);
      fireEvent.click(await screen.findByRole("button", { name: "Open workspace deletion confirmation" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Workspace name confirmation" }), { target: { value: "Workspace Alpha" } });
      fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));
      await waitFor(() => assert.ok(finishDelete));

      view.rerender(<AppRouterContext.Provider value={router(pushed)}><WorkspaceSettingsPage workspaceId="workspace_2" /></AppRouterContext.Provider>);
      assert.equal((await screen.findByRole("textbox", { name: "Workspace name" }) as HTMLInputElement).value, "Workspace Beta");
      await act(async () => finishDelete!());
      assert.deepEqual(pushed, []);
      assert.equal((screen.getByRole("textbox", { name: "Workspace name" }) as HTMLInputElement).value, "Workspace Beta");
    } finally { Object.assign(apiClient, original); }
  });

  it("does not expose deletion to a non-owner and returns to workspaces after workspace deletion", async () => {
    const original = { projectSettings: apiClient.projectSettings, workspaceSettings: apiClient.workspaceSettings, currentIdentity: apiClient.currentIdentity, deleteWorkspace: apiClient.deleteWorkspace };
    const pushed: string[] = [];
    apiClient.projectSettings = async () => projectSettings;
    apiClient.workspaceSettings = async () => workspaceSettings;
    apiClient.currentIdentity = async () => ({ user: { id: "admin_1", email: "admin@example.test" } });
    apiClient.deleteWorkspace = async () => ({ deleted: true });
    try {
      const project = render(<AppRouterContext.Provider value={router(pushed)}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      await screen.findByRole("button", { name: "Save project" });
      assert.equal(screen.queryByRole("button", { name: "Open project deletion confirmation" }), null);
      project.unmount();
      const workspace = render(<AppRouterContext.Provider value={router(pushed)}><WorkspaceSettingsPage workspaceId="workspace_1" /></AppRouterContext.Provider>);
      await screen.findByRole("button", { name: "Save workspace" });
      assert.equal(screen.queryByRole("button", { name: "Open workspace deletion confirmation" }), null);
      workspace.unmount();
      apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
      render(<AppRouterContext.Provider value={router(pushed)}><WorkspaceSettingsPage workspaceId="workspace_1" /></AppRouterContext.Provider>);
      fireEvent.click(await screen.findByRole("button", { name: "Open workspace deletion confirmation" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Workspace name confirmation" }), { target: { value: "Workspace Alpha" } });
      fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));
      await waitFor(() => assert.deepEqual(pushed, ["/"]));
    } finally {
      apiClient.projectSettings = original.projectSettings;
      apiClient.workspaceSettings = original.workspaceSettings;
      apiClient.currentIdentity = original.currentIdentity;
      apiClient.deleteWorkspace = original.deleteWorkspace;
    }
  });
});

function router(pushed: string[]) { return { back() {}, forward() {}, refresh() {}, push(path: string) { pushed.push(path); }, replace() {}, prefetch() {} }; }
function installDom() { const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" }); Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true }); Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator }); Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent }); Object.assign(dom.window.HTMLElement.prototype, { hasPointerCapture() { return false; }, setPointerCapture() {}, releasePointerCapture() {}, scrollIntoView() {} }); if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } }); }
