import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import React from "react";
import { apiClient, type Profile, type ProjectSettings } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { ProfilePage } = await import("../../src/components/profile/ProfilePage.js");
const { ProjectSettingsPage } = await import("../../src/components/settings/ProjectSettingsPage.js");

afterEach(() => cleanup());

const profile: Profile = { user: { id: "user_1", email: "owner@example.test", pictureUrl: "https://idp.test/owner.png", emailVerified: true, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }, preferences: { userId: "user_1", displayName: "Owner", timezone: "UTC", bio: "Builds tools", jobTitle: "Engineer", company: "AgentSmith", greetingPreference: "Hello", interests: ["Engineering"], updatedAt: "2026-07-11T00:00:00.000Z" } };
const settings: ProjectSettings = { project: { id: "project_1", workspaceId: "workspace_1", name: "Project", taskConcurrencyLimit: 2, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }, capabilities: { canManageSettings: true } };

describe("profile and settings pages", () => {
  it("renders immutable identity and sends profile/project mutations through the API client", async () => {
    const original = { profile: apiClient.profile, updateProfile: apiClient.updateProfile, projectSettings: apiClient.projectSettings, updateProjectSettings: apiClient.updateProjectSettings, currentIdentity: apiClient.currentIdentity };
    const updates: unknown[] = [];
    apiClient.profile = async () => profile;
    apiClient.updateProfile = async (input) => { updates.push(input); return profile; };
    apiClient.projectSettings = async () => settings;
    apiClient.updateProjectSettings = async (_id, input) => { updates.push(input); return settings; };
    apiClient.currentIdentity = async () => ({ user: profile.user });
    try {
      const view = render(<ProfilePage />);
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
      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      await waitFor(() => assert.equal(updates.length, 1));
      view.unmount();
      render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      await screen.findByRole("link", { name: "Manage members" });
      fireEvent.click(screen.getByRole("button", { name: "Save project" }));
      await waitFor(() => assert.equal(updates.length, 2));
    } finally {
      apiClient.profile = original.profile;
      apiClient.updateProfile = original.updateProfile;
      apiClient.projectSettings = original.projectSettings;
      apiClient.updateProjectSettings = original.updateProjectSettings;
      apiClient.currentIdentity = original.currentIdentity;
    }
  });

  it("shows archived project read-only state and keeps ownership transfer owner-scoped", async () => {
    const original={projectSettings:apiClient.projectSettings,currentIdentity:apiClient.currentIdentity,members:apiClient.members,unarchiveProject:apiClient.unarchiveProject};
    apiClient.projectSettings=async()=>({...settings,project:{...settings.project,ownerUserId:"user_1",lifecycleStatus:"archived"}});
    apiClient.currentIdentity=async()=>({user:profile.user});
    apiClient.members=async()=>[{projectId:"project_1",userId:"user_1",role:"owner",createdAt:"x",updatedAt:"x"},{projectId:"project_1",userId:"user_2",role:"member",createdAt:"x",updatedAt:"x"}];
    apiClient.unarchiveProject=async()=>({...settings.project,ownerUserId:"user_1",lifecycleStatus:"active"});
    try { render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1"/></AppRouterContext.Provider>); await screen.findByRole("status"); assert.equal((screen.getByRole("textbox",{name:"Project name"}) as HTMLInputElement).disabled,true); assert.ok(screen.getByRole("button",{name:"Unarchive project"})); assert.ok(screen.getByRole("combobox",{name:"New project owner"})); } finally {apiClient.projectSettings=original.projectSettings;apiClient.currentIdentity=original.currentIdentity;apiClient.members=original.members;apiClient.unarchiveProject=original.unarchiveProject;}
  });
});

function router() { return { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }; }
function installDom() { const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" }); Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, HTMLButtonElement: dom.window.HTMLButtonElement, Element: dom.window.Element, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true }); Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator }); Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent }); if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } }); }
