import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import React from "react";
import { ApiError, apiClient, type Profile, type ProjectSettings, type WorkspaceSettings } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { ProfilePage } = await import("../../src/components/profile/ProfilePage.js");
const { ProjectSettingsPage } = await import("../../src/components/settings/ProjectSettingsPage.js");
const { WorkspaceSettingsPage } = await import("../../src/components/settings/WorkspaceSettingsPage.js");

afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

const profile: Profile = { user: { id: "user_1", email: "owner@example.test", pictureUrl: "https://idp.test/owner.png", emailVerified: true, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }, preferences: { userId: "user_1", displayName: "Owner", timezone: "UTC", bio: "Builds tools", jobTitle: "Engineer", company: "AgentSmith", greetingPreference: "Hello", interests: ["Engineering"], updatedAt: "2026-07-11T00:00:00.000Z" } };
const settings: ProjectSettings = { project: { id: "project_1", workspaceId: "workspace_1", name: "Project", taskConcurrencyLimit: 2, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }, capabilities: { canManageSettings: true } };
const workspaceSettings: WorkspaceSettings = { workspace: { id: "workspace_1", name: "Workspace", ownerUserId: "user_1", projects: [], capabilities: { canCreateProject: true, canManageMembers: true }, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }, capabilities: { canManageSettings: true } };

describe("profile and settings pages", () => {
  it("renders immutable identity and only sends changed profile/project mutations", async () => {
    const original = { profile: apiClient.profile, updateProfile: apiClient.updateProfile, projectSettings: apiClient.projectSettings, updateProjectSettings: apiClient.updateProjectSettings, currentIdentity: apiClient.currentIdentity };
    const updates: unknown[] = [];
    apiClient.profile = async () => profile;
    apiClient.updateProfile = async (input) => { updates.push(input); return profile; };
    apiClient.projectSettings = async () => settings;
    apiClient.updateProjectSettings = async (_id, input) => { updates.push(input); return settings; };
    apiClient.currentIdentity = async () => ({ user: profile.user });
    try {
      const view = render(<AppRouterContext.Provider value={router()}><ProfilePage /></AppRouterContext.Provider>);
      await screen.findByText("owner@example.test");
      assert.equal(screen.getByAltText("Profile avatar").getAttribute("src"), "https://idp.test/owner.png");
      assert.ok(screen.getByRole("heading", { name: "Identity" }));
      assert.ok(screen.getByRole("heading", { name: "Basic information" }));
      assert.ok(screen.getByRole("heading", { name: "Work information" }));
      assert.ok(screen.getByRole("heading", { name: "Preferences" }));
      assert.ok(screen.getByRole("combobox", { name: "Greeting style" }));
      assert.ok(screen.getByDisplayValue("Builds tools"));
      assert.ok(screen.getByDisplayValue("Engineer"));
      assert.equal(screen.queryByText("Account ID"), null);
      assert.equal(screen.queryByText("user_1"), null);
      assert.equal(screen.queryByText("https://idp.test"), null);
      const saveProfile = screen.getByRole("button", { name: "Save profile" }) as HTMLButtonElement;
      assert.equal(saveProfile.disabled, true);
      fireEvent.submit(saveProfile.closest("form")!);
      assert.deepEqual(updates, []);
      fireEvent.change(screen.getByRole("textbox", { name: "Display name" }), { target: { value: "Updated owner" } });
      assert.equal(saveProfile.disabled, false);
      fireEvent.click(saveProfile);
      await waitFor(() => assert.equal(updates.length, 1));
      view.unmount();
      render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      await screen.findByRole("link", { name: "Manage members" });
      const saveProject = screen.getByRole("button", { name: "Save project" }) as HTMLButtonElement;
      assert.equal(saveProject.disabled, true);
      fireEvent.submit(saveProject.closest("form")!);
      assert.equal(updates.length, 1);
      fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Updated project" } });
      assert.equal(saveProject.disabled, false);
      fireEvent.click(saveProject);
      await waitFor(() => assert.equal(updates.length, 2));
      assert.deepEqual(updates[1], { name: "Updated project" });
      assert.equal(screen.queryByRole("spinbutton", { name: "Task concurrency" }), null);
    } finally {
      apiClient.profile = original.profile;
      apiClient.updateProfile = original.updateProfile;
      apiClient.projectSettings = original.projectSettings;
      apiClient.updateProjectSettings = original.updateProjectSettings;
      apiClient.currentIdentity = original.currentIdentity;
    }
  });

  it("only enables workspace saving after its name changes", async () => {
    const original = { workspaceSettings: apiClient.workspaceSettings, updateWorkspaceSettings: apiClient.updateWorkspaceSettings, currentIdentity: apiClient.currentIdentity, workspaceMembers: apiClient.workspaceMembers };
    const updates: unknown[] = [];
    apiClient.workspaceSettings = async () => workspaceSettings;
    apiClient.currentIdentity = async () => ({ user: profile.user });
    apiClient.workspaceMembers = async () => [];
    apiClient.updateWorkspaceSettings = async (_id, input) => { updates.push(input); return { ...workspaceSettings, workspace: { ...workspaceSettings.workspace, name: input.name } }; };
    try {
      render(<AppRouterContext.Provider value={router()}><WorkspaceSettingsPage workspaceId="workspace_1" /></AppRouterContext.Provider>);
      const name = await screen.findByRole("textbox", { name: "Workspace name" });
      const save = screen.getByRole("button", { name: "Save workspace" }) as HTMLButtonElement;
      assert.equal(save.disabled, true);
      fireEvent.submit(save.closest("form")!);
      assert.deepEqual(updates, []);
      fireEvent.change(name, { target: { value: "Updated workspace" } });
      assert.equal(save.disabled, false);
      fireEvent.click(save);
      await waitFor(() => assert.deepEqual(updates, [{ name: "Updated workspace" }]));
      assert.equal(save.disabled, true);
    } finally { Object.assign(apiClient, original); }
  });

  it("changes the project settings key when the submitted name changes", async () => {
    const original = { projectSettings: apiClient.projectSettings, updateProjectSettings: apiClient.updateProjectSettings, currentIdentity: apiClient.currentIdentity };
    const keys: string[] = [];
    apiClient.projectSettings = async () => settings;
    apiClient.currentIdentity = async () => ({ user: profile.user });
    apiClient.updateProjectSettings = (async (_projectId: string, input: { name?: string }, key: string) => {
      keys.push(key);
      if (keys.length === 1) throw new Error("connection closed");
      return { ...settings, project: { ...settings.project, name: input.name ?? settings.project.name } };
    }) as typeof apiClient.updateProjectSettings;
    try {
      render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      const name = await screen.findByRole("textbox", { name: "Project name" });
      fireEvent.change(name, { target: { value: "Renamed project" } });
      fireEvent.click(screen.getByRole("button", { name: "Save project" }));
      await waitFor(() => assert.equal(keys.length, 1));
      fireEvent.change(name, { target: { value: " Renamed project " } });
      fireEvent.click(screen.getByRole("button", { name: "Save project" }));
      await waitFor(() => assert.equal(keys.length, 2));
      assert.notEqual(keys[1], keys[0]);
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps the project name stable while saving and adopts the saved server value", async () => {
    const original = { projectSettings: apiClient.projectSettings, updateProjectSettings: apiClient.updateProjectSettings, currentIdentity: apiClient.currentIdentity };
    let finishSave!: (value: ProjectSettings) => void;
    apiClient.projectSettings = async () => settings;
    apiClient.currentIdentity = async () => ({ user: profile.user });
    apiClient.updateProjectSettings = async () => new Promise((resolve) => { finishSave = resolve; });
    let directoryChanges = 0;
    const changed = () => { directoryChanges += 1; };
    window.addEventListener("agentsmith:directory-changed", changed);
    try {
      render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      const name = await screen.findByRole("textbox", { name: "Project name" }) as HTMLInputElement;
      fireEvent.change(name, { target: { value: "  Renamed project  " } });
      fireEvent.click(screen.getByRole("button", { name: "Save project" }));
      await waitFor(() => assert.equal(name.disabled, true));
      await act(async () => finishSave({ ...settings, project: { ...settings.project, name: "Renamed project" } }));
      assert.equal(name.value, "Renamed project");
      assert.equal(name.disabled, false);
      assert.equal(directoryChanges, 1);
    } finally { window.removeEventListener("agentsmith:directory-changed", changed); Object.assign(apiClient, original); }
  });

  it("keeps profile fields stable while saving and adopts saved server values", async () => {
    const original = { profile: apiClient.profile, updateProfile: apiClient.updateProfile };
    let finishSave!: (value: Profile) => void;
    apiClient.profile = async () => profile;
    apiClient.updateProfile = async () => new Promise((resolve) => { finishSave = resolve; });
    try {
      render(<AppRouterContext.Provider value={router()}><ProfilePage /></AppRouterContext.Provider>);
      const displayName = await screen.findByRole("textbox", { name: "Display name" }) as HTMLInputElement;
      fireEvent.change(displayName, { target: { value: "  Canonical owner  " } });
      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      await waitFor(() => assert.equal(displayName.disabled, true));
      await act(async () => finishSave({ ...profile, preferences: { ...profile.preferences, displayName: "Canonical owner" } }));
      assert.equal(displayName.value, "Canonical owner");
      assert.equal(displayName.disabled, false);
    } finally { Object.assign(apiClient, original); }
  });

  it("shows archived project read-only state and keeps ownership transfer owner-scoped", async () => {
    const original={projectSettings:apiClient.projectSettings,currentIdentity:apiClient.currentIdentity,members:apiClient.members,unarchiveProject:apiClient.unarchiveProject};
    apiClient.projectSettings=async()=>({...settings,project:{...settings.project,ownerUserId:"user_1",lifecycleStatus:"archived"}});
    apiClient.currentIdentity=async()=>({user:profile.user});
    apiClient.members=async()=>[{projectId:"project_1",userId:"user_1",role:"owner",createdAt:"x",updatedAt:"x"},{projectId:"project_1",userId:"user_2",role:"member",createdAt:"x",updatedAt:"x"}];
    apiClient.unarchiveProject=async()=>({...settings.project,ownerUserId:"user_1",lifecycleStatus:"active"});
    try { render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1"/></AppRouterContext.Provider>); await screen.findByRole("status"); assert.equal((screen.getByRole("textbox",{name:"Project name"}) as HTMLInputElement).disabled,true); assert.ok(screen.getByRole("button",{name:"Unarchive project"})); assert.ok(screen.getByRole("combobox",{name:"New project owner"})); } finally {apiClient.projectSettings=original.projectSettings;apiClient.currentIdentity=original.currentIdentity;apiClient.members=original.members;apiClient.unarchiveProject=original.unarchiveProject;}
  });

  it("keeps project ownership transfer disabled when the containing workspace is read-only", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity, members: apiClient.members };
    apiClient.projectSettings = async () => ({ ...settings, project: { ...settings.project, ownerUserId: "user_1", lifecycleStatus: "active" }, capabilities: { canManageSettings: false } });
    apiClient.currentIdentity = async () => ({ user: profile.user });
    apiClient.members = async () => [
      { projectId: "project_1", userId: "user_1", role: "owner", email: "owner@example.test", createdAt: "x", updatedAt: "x" },
      { projectId: "project_1", userId: "user_2", role: "admin", email: "candidate@example.test", createdAt: "x", updatedAt: "x" },
    ];
    try {
      render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      const owner = await screen.findByRole("combobox", { name: "New project owner" }) as HTMLButtonElement;
      assert.equal(owner.disabled, true);
      assert.equal((screen.getByRole("button", { name: "Transfer ownership" }) as HTMLButtonElement).disabled, true);
    } finally { Object.assign(apiClient, original); }
  });

  it("reports an ownership candidate load failure instead of claiming there are no members", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity, members: apiClient.members };
    apiClient.projectSettings = async () => ({ ...settings, project: { ...settings.project, ownerUserId: "user_1" } });
    apiClient.currentIdentity = async () => ({ user: profile.user });
    apiClient.members = async () => { throw new Error("network unavailable"); };
    try {
      render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      const alert = await screen.findByRole("alert");
      assert.match(alert.textContent ?? "", /Project members could not be loaded/);
      assert.equal(screen.queryByText("There are no other project members eligible to become owner."), null);
      assert.ok(screen.getByRole("button", { name: "Retry member loading" }));
    } finally { Object.assign(apiClient, original); }
  });

  it("preserves the project return path on the single profile page", async () => {
    const original = apiClient.profile;
    apiClient.profile = async () => profile;
    window.history.replaceState({}, "", "/profile?returnTo=%2Fworkspaces%2Fworkspace_1%2Fprojects%2Fproject_1%2Ftasks");
    try {
      render(<AppRouterContext.Provider value={router()}><ProfilePage /></AppRouterContext.Provider>);
      const back = await screen.findByRole("link", { name: "Back to project" });
      assert.equal(back.getAttribute("href"), "/workspaces/workspace_1/projects/project_1/tasks");
    } finally { apiClient.profile = original; }
  });

  it("removes the deployed app base path from the profile return route", async () => {
    const original = apiClient.profile;
    apiClient.profile = async () => profile;
    window.history.replaceState({}, "", "/app/profile?returnTo=%2Fapp%2Fworkspaces%2Fworkspace_1%2Fprojects%2Fproject_1%2Ftasks");
    try {
      render(<AppRouterContext.Provider value={router()}><ProfilePage /></AppRouterContext.Provider>);
      const back = await screen.findByRole("link", { name: "Back to project" });
      assert.equal(back.getAttribute("href"), "/workspaces/workspace_1/projects/project_1/tasks");
    } finally { apiClient.profile = original; }
  });

  it("confirms before leaving with unsaved profile changes", async () => {
    const original = apiClient.profile;
    const pushed: string[] = [];
    apiClient.profile = async () => profile;
    window.history.replaceState({}, "", "/profile?returnTo=%2Fworkspaces%2Fworkspace_1%2Fprojects%2Fproject_1%2Ftasks");
    try {
      render(<AppRouterContext.Provider value={router(pushed)}><ProfilePage /></AppRouterContext.Provider>);
      fireEvent.change(await screen.findByRole("textbox", { name: "Display name" }), { target: { value: "Unsaved owner" } });
      fireEvent.click(screen.getByRole("link", { name: "Back to project" }));
      await screen.findByRole("alertdialog", { name: "Discard unsaved profile changes?" });
      assert.deepEqual(pushed, []);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      assert.equal((screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement).value, "Unsaved owner");

      fireEvent.click(screen.getByRole("link", { name: "Back to project" }));
      fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
      await waitFor(() => assert.deepEqual(pushed, ["/workspaces/workspace_1/projects/project_1/tasks"]));
    } finally { apiClient.profile = original; }
  });

  it("keeps a specific settings load error with retry and return actions", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity };
    apiClient.projectSettings = async () => { throw new ApiError(403, "Project settings require administrator access."); };
    apiClient.currentIdentity = async () => ({ user: profile.user });
    try {
      render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      const alert = await screen.findByRole("alert");
      assert.ok(alert.textContent?.includes("Project settings require administrator access."));
      assert.ok(screen.getByRole("button", { name: "Try again" }));
      assert.equal(screen.getByRole("link", { name: "Back to project" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/overview");
    } finally { Object.assign(apiClient, original); }
  });

  it("allows an administrator to archive but not restore a project", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity, archiveProject: apiClient.archiveProject };
    const archived = { ...settings.project, ownerUserId: "owner_1", lifecycleStatus: "archived" as const };
    apiClient.currentIdentity = async () => ({ user: { id: "admin_1", email: "admin@example.test" } });
    apiClient.projectSettings = async () => ({ ...settings, project: { ...settings.project, ownerUserId: "owner_1", lifecycleStatus: "active" } });
    apiClient.archiveProject = async () => archived;
    try {
      const view = render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      fireEvent.click(await screen.findByRole("button", { name: "Archive project" }));
      const dialog = screen.getByRole("alertdialog");
      assert.ok(within(dialog).getByRole("heading", { name: "Archive project" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Archive project" }));
      await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Unarchive project" }), null));
      view.unmount();
      apiClient.projectSettings = async () => ({ ...settings, project: archived });
      render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      await screen.findByRole("status");
      assert.equal(screen.queryByRole("button", { name: "Unarchive project" }), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("locks other project settings while an archive request is in flight", async () => {
    const original = { projectSettings: apiClient.projectSettings, currentIdentity: apiClient.currentIdentity, members: apiClient.members, archiveProject: apiClient.archiveProject };
    let finishArchive!: (value: ProjectSettings["project"]) => void;
    apiClient.projectSettings = async () => ({ ...settings, project: { ...settings.project, ownerUserId: "user_1", lifecycleStatus: "active" } });
    apiClient.currentIdentity = async () => ({ user: profile.user });
    apiClient.members = async () => [];
    apiClient.archiveProject = async () => new Promise((resolve) => { finishArchive = resolve; });
    try {
      render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      fireEvent.click(await screen.findByRole("button", { name: "Archive project" }));
      fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Archive project" }));
      await waitFor(() => assert.ok(finishArchive));

      assert.equal((document.querySelector('input[name="name"]') as HTMLInputElement).disabled, true);
      assert.equal((document.querySelector('button[aria-label="Open project deletion confirmation"]') as HTMLButtonElement).disabled, true);

      await act(async () => finishArchive({ ...settings.project, ownerUserId: "user_1", lifecycleStatus: "archived" }));
    } finally { Object.assign(apiClient, original); }
  });
});

function router(pushed: string[] = []) { return { back() {}, forward() {}, refresh() {}, push(path: string) { pushed.push(path); }, replace() {}, prefetch() {} }; }
function installDom() { const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" }); Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, HTMLButtonElement: dom.window.HTMLButtonElement, Element: dom.window.Element, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true }); Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator }); Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent }); if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } }); }
