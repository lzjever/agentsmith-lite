import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import React, { useState } from "react";
import { apiClient, type EndpointInput, type ProjectCredential, type ProjectSettings, type WorkspaceSettings } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { EndpointDialog } = await import("../../src/components/endpoints/EndpointDialog.js");
const { ProjectSettingsPage } = await import("../../src/components/settings/ProjectSettingsPage.js");
const { WorkspaceSettingsPage } = await import("../../src/components/settings/WorkspaceSettingsPage.js");

const timestamp = "2026-07-11T00:00:00.000Z";
const credentials: ProjectCredential[] = [{ id: "credential_1", projectId: "project_1", name: "DeepSeek", type: "api_key", baseUrl: "https://api.deepseek.test/v1", fingerprint: "key-123", version: 1, createdAt: timestamp, lastRotatedAt: null, updatedAt: timestamp }];
const projectSettings: ProjectSettings = { project: { id: "project_1", workspaceId: "workspace_1", ownerUserId: "owner_1", name: "Project", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp }, capabilities: { canManageSettings: true } };
const workspaceSettings: WorkspaceSettings = { workspace: { id: "workspace_1", ownerUserId: "owner_1", name: "Workspace", projects: [], capabilities: { canCreateProject: true, canManageMembers: true }, createdAt: timestamp, updatedAt: timestamp }, capabilities: { canManageSettings: true } };

afterEach(() => cleanup());

describe("business shared controls", () => {
  it("binds an endpoint credential and base URL through the shared Select", async () => {
    const changes: EndpointInput[] = [];
    const view = render(<EndpointHarness onChange={(value) => changes.push(value)} />);
    const credential = screen.getByRole("combobox", { name: "Credential" });
    assert.equal((credential as HTMLButtonElement).disabled, false);
    const bridge = document.querySelector("select");
    assert.ok(bridge, "shared Select should render its native form bridge");
    fireEvent.change(bridge, { target: { value: credentials[0]!.id } });
    await waitFor(() => assert.equal(changes.length, 1));
    assert.equal(changes[0]?.credentialId, credentials[0]!.id);
    assert.equal(changes[0]?.baseUrl, credentials[0]!.baseUrl);
    assert.equal((screen.getByLabelText("Base URL") as HTMLInputElement).readOnly, true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Tool calls" }));
    await waitFor(() => assert.deepEqual(changes.at(-1)?.capabilities, ["text", "tool_calls"]));
    view.rerender(<EndpointHarness saving onChange={() => undefined} />);
    assert.equal((screen.getByRole("combobox", { name: "Credential" }) as HTMLButtonElement).disabled, true);
  });

  it("transfers project ownership from the shared owner Select", async () => {
    const original = snapshotClient();
    const transfers: string[] = [];
    let settingsReads = 0;
    apiClient.projectSettings = async () => { settingsReads++; return projectSettings; };
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.members = async () => [{ projectId: "project_1", userId: "owner_1", role: "owner", displayName: "Owner Person", email: "owner@example.test", createdAt: timestamp, updatedAt: timestamp }, { projectId: "project_1", userId: "member_1", role: "member", displayName: "Member Person", email: "member@example.test", createdAt: timestamp, updatedAt: timestamp }];
    apiClient.transferProjectOwner = async (_projectId, userId) => { transfers.push(userId); return { transferred: true }; };
    try {
      render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      const owner = await screen.findByRole("combobox", { name: "New project owner" });
      fireEvent.click(owner);
      fireEvent.click(await screen.findByRole("option", { name: "Member Person" }));
      const actions = screen.getAllByRole("button", { name: "Transfer ownership" });
      fireEvent.click(actions[0]!);
      const confirm = (await screen.findAllByRole("button", { name: "Transfer ownership" })).at(-1)!;
      await act(async () => { fireEvent.click(confirm); await Promise.resolve(); });
      assert.deepEqual(transfers, ["member_1"]);
      assert.equal(settingsReads, 1);
      assert.equal(screen.queryByRole("combobox", { name: "New project owner" }), null);
    } finally { restoreClient(original); }
  });

  it("transfers workspace ownership from the shared owner Select", async () => {
    const original = snapshotClient();
    const transfers: string[] = [];
    let settingsReads = 0;
    apiClient.workspaceSettings = async () => { settingsReads++; return workspaceSettings; };
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.workspaceMembers = async () => [{ workspaceId: "workspace_1", userId: "owner_1", role: "owner", displayName: "Owner Person", email: "owner@example.test", createdAt: timestamp, updatedAt: timestamp }, { workspaceId: "workspace_1", userId: "member_1", role: "member", displayName: "Member Person", email: "member@example.test", createdAt: timestamp, updatedAt: timestamp }];
    apiClient.transferWorkspaceOwner = async (_workspaceId, userId) => { transfers.push(userId); return { transferred: true }; };
    try {
      render(<AppRouterContext.Provider value={router()}><WorkspaceSettingsPage workspaceId="workspace_1" /></AppRouterContext.Provider>);
      const owner = await screen.findByRole("combobox", { name: "New workspace owner" });
      fireEvent.click(owner);
      fireEvent.click(await screen.findByRole("option", { name: "Member Person" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Transfer ownership" })[0]!);
      const confirm = (await screen.findAllByRole("button", { name: "Transfer ownership" })).at(-1)!;
      await act(async () => { fireEvent.click(confirm); await Promise.resolve(); });
      assert.deepEqual(transfers, ["member_1"]);
      assert.equal(settingsReads, 1);
      assert.equal(screen.queryByRole("combobox", { name: "New workspace owner" }), null);
    } finally { restoreClient(original); }
  });

  it("keeps the workspace name stable while saving and adopts the saved server value", async () => {
    const original = snapshotClient();
    let finishSave!: (value: WorkspaceSettings) => void;
    apiClient.workspaceSettings = async () => workspaceSettings;
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.workspaceMembers = async () => [];
    apiClient.updateWorkspaceSettings = async () => new Promise((resolve) => { finishSave = resolve; });
    let directoryChanges = 0;
    const changed = () => { directoryChanges += 1; };
    window.addEventListener("agentsmith:directory-changed", changed);
    try {
      render(<AppRouterContext.Provider value={router()}><WorkspaceSettingsPage workspaceId="workspace_1" /></AppRouterContext.Provider>);
      const name = await screen.findByRole("textbox", { name: "Workspace name" }) as HTMLInputElement;
      fireEvent.change(name, { target: { value: "  Renamed workspace  " } });
      fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
      await waitFor(() => assert.equal(name.disabled, true));
      await act(async () => finishSave({ ...workspaceSettings, workspace: { ...workspaceSettings.workspace, name: "Renamed workspace" } }));
      assert.equal(name.value, "Renamed workspace");
      assert.equal(name.disabled, false);
      assert.equal(directoryChanges, 1);
    } finally { window.removeEventListener("agentsmith:directory-changed", changed); restoreClient(original); }
  });

  it("shows an explicit empty state when ownership has no eligible recipient", async () => {
    const original = snapshotClient();
    apiClient.projectSettings = async () => projectSettings;
    apiClient.workspaceSettings = async () => workspaceSettings;
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.members = async () => [{ projectId: "project_1", userId: "owner_1", role: "owner", displayName: "Owner Person", email: "owner@example.test", createdAt: timestamp, updatedAt: timestamp }];
    apiClient.workspaceMembers = async () => [{ workspaceId: "workspace_1", userId: "owner_1", role: "owner", displayName: "Owner Person", email: "owner@example.test", createdAt: timestamp, updatedAt: timestamp }];
    try {
      const project = render(<AppRouterContext.Provider value={router()}><ProjectSettingsPage workspaceId="workspace_1" projectId="project_1" /></AppRouterContext.Provider>);
      await screen.findByText("There are no other project members eligible to become owner.");
      assert.equal(screen.queryByRole("combobox", { name: "New project owner" }), null);
      project.unmount();
      render(<AppRouterContext.Provider value={router()}><WorkspaceSettingsPage workspaceId="workspace_1" /></AppRouterContext.Provider>);
      await screen.findByText("There are no other workspace members eligible to become owner.");
      assert.equal(screen.queryByRole("combobox", { name: "New workspace owner" }), null);
    } finally { restoreClient(original); }
  });

  it("confirms workspace archiving before changing lifecycle state", async () => {
    const original = snapshotClient();
    let archived = false;
    apiClient.workspaceSettings = async () => workspaceSettings;
    apiClient.currentIdentity = async () => ({ user: { id: "owner_1", email: "owner@example.test" } });
    apiClient.workspaceMembers = async () => [];
    apiClient.archiveWorkspace = async () => {
      archived = true;
      return { ...workspaceSettings.workspace, lifecycleStatus: "archived" };
    };
    try {
      render(<AppRouterContext.Provider value={router()}><WorkspaceSettingsPage workspaceId="workspace_1" /></AppRouterContext.Provider>);
      fireEvent.click(await screen.findByRole("button", { name: "Archive workspace" }));
      assert.equal(archived, false);
      const dialog = screen.getByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Archive workspace" }));
      await waitFor(() => assert.equal(archived, true));
    } finally { restoreClient(original); }
  });
});

function EndpointHarness({ saving = false, onChange }: { saving?: boolean; onChange: (value: EndpointInput) => void }) {
  const [input, setInput] = useState<EndpointInput>({ name: "Endpoint", baseUrl: "", model: "deepseek-chat", credentialId: "", capabilities: ["text"], requestTimeoutSecs: 30 });
  return <EndpointDialog open input={input} editing={false} saving={saving} discovering={false} models={[]} canSubmit error="" credentials={credentials} onDiscoverModels={() => undefined} onDismissError={() => undefined} onOpenChange={() => undefined} onChange={(value) => { setInput(value); onChange(value); }} onSubmit={(event) => event.preventDefault()} />;
}

function snapshotClient() { return { projectSettings: apiClient.projectSettings, workspaceSettings: apiClient.workspaceSettings, updateWorkspaceSettings: apiClient.updateWorkspaceSettings, currentIdentity: apiClient.currentIdentity, members: apiClient.members, workspaceMembers: apiClient.workspaceMembers, transferProjectOwner: apiClient.transferProjectOwner, transferWorkspaceOwner: apiClient.transferWorkspaceOwner, archiveWorkspace: apiClient.archiveWorkspace }; }
function restoreClient(value: ReturnType<typeof snapshotClient>) { Object.assign(apiClient, value); }
function router() { return { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }; }

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, { hasPointerCapture() { return false; }, setPointerCapture() {}, releasePointerCapture() {}, scrollIntoView() {} });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
