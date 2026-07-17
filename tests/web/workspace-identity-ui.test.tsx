import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import React from "react";
import { ApiError, apiClient, type Workspace, type WorkspaceMember } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { WorkspaceDirectoryPage } = await import("../../src/components/workspaces/WorkspaceDirectoryPage.js");
const { WorkspaceProjectsEntryPage } = await import("../../src/components/workspaces/WorkspaceProjectsEntryPage.js");
const { WorkspaceMembersPage } = await import("../../src/components/workspaces/WorkspaceMembersPage.js");

const timestamp = "2026-07-11T00:00:00.000Z";
const workspace: Workspace = { id: "workspace_1", name: "Workspace", ownerUserId: "owner_1", owner: { displayName: "Owner Person", email: "owner@example.test" }, memberRole: "viewer", projects: [], capabilities: { canCreateProject: false, canManageMembers: false }, createdAt: timestamp, updatedAt: timestamp };
const owner: WorkspaceMember = { workspaceId: workspace.id, userId: "owner_1", role: "owner", displayName: "Owner Person", email: "owner@example.test", createdAt: timestamp, updatedAt: timestamp };

afterEach(() => cleanup());

describe("workspace identity UX", () => {
  it("opens workspace creation with a fresh form after cancellation", async () => {
    const original = apiClient.workspaces;
    apiClient.workspaces = async () => [workspace];
    try {
      render(<WorkspaceDirectoryPage />);
      const create = await screen.findByRole("button", { name: "New workspace" });
      await screen.findByText("Workspace");
      fireEvent.click(create);
      const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
      fireEvent.change(name, { target: { value: "Discarded workspace" } });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "New workspace" }), null));

      fireEvent.click(create);
      assert.equal((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value, "");
    } finally { apiClient.workspaces = original; }
  });

  it("reuses a workspace creation key after an unknown network result", async () => {
    const original = { workspaces: apiClient.workspaces, createWorkspace: apiClient.createWorkspace };
    const keys: string[] = [];
    let attempts = 0;
    apiClient.workspaces = async () => [];
    apiClient.createWorkspace = (async (_name: string, key: string) => {
      keys.push(key);
      if (++attempts === 1) throw new Error("connection closed");
      return workspace;
    }) as typeof apiClient.createWorkspace;
    try {
      render(<WorkspaceDirectoryPage />);
      const create = await screen.findByRole("button", { name: "New workspace" }) as HTMLButtonElement;
      await waitFor(() => assert.equal(create.disabled, false));
      fireEvent.click(create);
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Workspace" } });
      fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
      await screen.findByRole("alert");
      fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
      await waitFor(() => assert.equal(attempts, 2));
      assert.equal(keys[0], keys[1]);
      assert.ok(keys[0]);
    } finally { Object.assign(apiClient, original); }
  });

  it("waits for the workspace directory before allowing creation", async () => {
    const original = apiClient.workspaces;
    let finishLoad!: (value: Workspace[]) => void;
    apiClient.workspaces = async () => new Promise((resolve) => { finishLoad = resolve; });
    try {
      render(<WorkspaceDirectoryPage />);
      const create = screen.getByRole("button", { name: "New workspace" }) as HTMLButtonElement;
      assert.equal(create.disabled, true);
      await act(async () => finishLoad([workspace]));
      await screen.findByText("Workspace");
      assert.equal(create.disabled, false);
    } finally { apiClient.workspaces = original; }
  });

  it("ignores a late project directory load after switching workspaces", async () => {
    const original = apiClient.workspaces;
    const secondProject = { id: "project_2", workspaceId: "workspace_2", name: "Second project", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp };
    const second = { ...workspace, id: "workspace_2", name: "Second workspace", owner: { displayName: "Second Owner", email: "second@example.test" }, projects: [secondProject] };
    let finishFirst!: (value: Workspace[]) => void;
    let reads = 0;
    apiClient.workspaces = async () => ++reads === 1 ? new Promise((resolve) => { finishFirst = resolve; }) : [second];
    try {
      const view = render(<AppRouterContext.Provider value={router()}><WorkspaceProjectsEntryPage workspaceId="workspace_1" /></AppRouterContext.Provider>);
      await waitFor(() => assert.equal(reads, 1));
      view.rerender(<AppRouterContext.Provider value={router()}><WorkspaceProjectsEntryPage workspaceId="workspace_2" /></AppRouterContext.Provider>);
      await screen.findAllByText("Second project");
      await act(async () => finishFirst([workspace]));
      assert.ok(screen.getAllByText("Second project").length > 0);
      assert.equal(screen.queryByText("Workspace"), null);
      assert.ok(screen.getByText("Owner: Second Owner · Your access: Viewer"));
    } finally { apiClient.workspaces = original; }
  });

  it("uses the workspace list projection for owner and current access summaries", async () => {
    const original = apiClient.workspaces;
    apiClient.workspaces = async () => [{ ...workspace, lifecycleStatus: "archived" }];
    try {
      const directory = render(<WorkspaceDirectoryPage />);
      await screen.findByText("Owner: Owner Person · Your access: Viewer");
      assert.ok(screen.getByText("Archived"));
      assert.equal(screen.queryByText("owner_1"), null);
      directory.unmount();
      render(<AppRouterContext.Provider value={router()}><WorkspaceProjectsEntryPage workspaceId={workspace.id} /></AppRouterContext.Provider>);
      await screen.findByText("Owner: Owner Person · Your access: Viewer");
    } finally { apiClient.workspaces = original; }
  });

  it("fails closed after a denied workspace membership mutation", async () => {
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
      assert.equal(screen.queryByRole("button", { name: "Retry" }), null);
      assert.equal(screen.queryByRole("dialog", { name: "Add workspace member" }), null);
      assert.equal(screen.queryByRole("button", { name: "Add member" }), null);
      assert.ok(screen.getByText("Your workspace access is read-only."));
      assert.ok(screen.getByText("Owner"));
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps a successful member addition when the following directory refresh fails", async () => {
    const original = { workspaces: apiClient.workspaces, workspaceMembers: apiClient.workspaceMembers, addWorkspaceMember: apiClient.addWorkspaceMember };
    const member: WorkspaceMember = { workspaceId: workspace.id, userId: "member_1", role: "member", displayName: "Member Person", email: "member@example.test", createdAt: timestamp, updatedAt: timestamp };
    let memberReads = 0;
    let additions = 0;
    apiClient.workspaces = async () => [{ ...workspace, memberRole: "admin", capabilities: { canCreateProject: true, canManageMembers: true } }];
    apiClient.workspaceMembers = async () => { memberReads += 1; if (memberReads > 1) throw new ApiError(503, "Member directory unavailable."); return [owner]; };
    apiClient.addWorkspaceMember = async () => { additions += 1; return member; };
    try {
      render(<WorkspaceMembersPage workspaceId={workspace.id} />);
      fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: member.email } });
      fireEvent.click(screen.getAllByRole("button", { name: "Add member" }).at(-1)!);
      await screen.findByText("Member Person");
      assert.equal(additions, 1);
      assert.equal(screen.queryByRole("dialog", { name: "Add workspace member" }), null);
      assert.equal(screen.queryByRole("button", { name: "Retry" }), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("reuses a workspace member creation key after an unknown network result", async () => {
    const original = { workspaces: apiClient.workspaces, workspaceMembers: apiClient.workspaceMembers, addWorkspaceMember: apiClient.addWorkspaceMember };
    const keys: string[] = [];
    let attempts = 0;
    const member: WorkspaceMember = { workspaceId: workspace.id, userId: "member_retry", role: "member", displayName: "Retry Member", email: "retry@example.test", createdAt: timestamp, updatedAt: timestamp };
    apiClient.workspaces = async () => [{ ...workspace, memberRole: "admin", capabilities: { canCreateProject: true, canManageMembers: true } }];
    apiClient.workspaceMembers = async () => [owner];
    apiClient.addWorkspaceMember = (async (_workspaceId:string,_email:string,_role:"member",key:string)=>{keys.push(key);if(++attempts===1)throw new Error("connection closed");return member;}) as typeof apiClient.addWorkspaceMember;
    try {
      render(<WorkspaceMembersPage workspaceId={workspace.id} />);
      fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: member.email } });
      fireEvent.click(screen.getAllByRole("button", { name: "Add member" }).at(-1)!);
      await screen.findByRole("button", { name: "Retry" });
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => assert.equal(attempts, 2));
      assert.ok(keys[0]);
      assert.equal(keys[1], keys[0]);
    } finally { Object.assign(apiClient, original); }
  });

  it("reuses a workspace member role key from the in-place retry", async () => {
    const original = { workspaces:apiClient.workspaces, workspaceMembers:apiClient.workspaceMembers, changeWorkspaceMember:apiClient.changeWorkspaceMember };
    const member:WorkspaceMember={...owner,userId:"member_role_retry",role:"member",displayName:"Role Retry",email:"role-retry@example.test"};
    const keys:string[]=[];let attempts=0;
    apiClient.workspaces=async()=>[{...workspace,memberRole:"admin",capabilities:{canCreateProject:true,canManageMembers:true}}];
    apiClient.workspaceMembers=async()=>[owner,member];
    apiClient.changeWorkspaceMember=(async(_workspaceId:string,_userId:string,_role:"admin",key:string)=>{keys.push(key);if(++attempts===1)throw new Error("connection closed");return{...member,role:"admin"};}) as typeof apiClient.changeWorkspaceMember;
    try {
      render(<WorkspaceMembersPage workspaceId={workspace.id}/>);
      fireEvent.click(await screen.findByRole("combobox",{name:"Role for Role Retry"}));
      fireEvent.click(await screen.findByRole("option",{name:"Admin"}));
      const alert=await screen.findByRole("alert");
      fireEvent.click(within(alert).getByRole("button",{name:"Retry"}));
      await waitFor(()=>assert.equal(attempts,2));
      assert.ok(keys[0]);assert.equal(keys[1],keys[0]);
      await waitFor(()=>assert.match(screen.getByRole("combobox",{name:"Role for Role Retry"}).textContent??"",/Admin/));
    } finally { Object.assign(apiClient,original); }
  });

  it("serializes workspace membership mutations", async () => {
    const original = { workspaces: apiClient.workspaces, workspaceMembers: apiClient.workspaceMembers, changeWorkspaceMember: apiClient.changeWorkspaceMember };
    const first: WorkspaceMember = { ...owner, userId: "member_1", role: "member", displayName: "First member", email: "first@example.test" };
    const second: WorkspaceMember = { ...owner, userId: "member_2", role: "viewer", displayName: "Second member", email: "second@example.test" };
    let changes = 0;
    apiClient.workspaces = async () => [{ ...workspace, memberRole: "admin", capabilities: { canCreateProject: true, canManageMembers: true } }];
    apiClient.workspaceMembers = async () => [owner, first, second];
    apiClient.changeWorkspaceMember = async () => { changes += 1; return new Promise(() => undefined); };
    try {
      render(<WorkspaceMembersPage workspaceId={workspace.id} />);
      fireEvent.click(await screen.findByRole("combobox", { name: "Role for First member" }));
      fireEvent.click(await screen.findByRole("option", { name: "Admin" }));
      await waitFor(() => assert.equal(changes, 1));
      assert.equal((screen.getByRole("button", { name: "Add member" }) as HTMLButtonElement).disabled, true);
      assert.equal((screen.getByRole("combobox", { name: "Role for First member" }) as HTMLButtonElement).disabled, true);
      assert.equal((screen.getByRole("combobox", { name: "Role for Second member" }) as HTMLButtonElement).disabled, true);
      assert.equal((screen.getByRole("button", { name: "Remove Second member" }) as HTMLButtonElement).disabled, true);
    } finally { Object.assign(apiClient, original); }
  });

  it("does not apply a member role change after switching workspaces", async () => {
    const original = { workspaces: apiClient.workspaces, workspaceMembers: apiClient.workspaceMembers, changeWorkspaceMember: apiClient.changeWorkspaceMember };
    const secondWorkspace = { ...workspace, id: "workspace_2", name: "Second workspace", memberRole: "admin" as const, capabilities: { canCreateProject: true, canManageMembers: true } };
    const firstMember: WorkspaceMember = { ...owner, userId: "member_a", role: "member", displayName: "Workspace A member", email: "a@example.test" };
    const secondMember: WorkspaceMember = { ...owner, workspaceId: secondWorkspace.id, userId: "member_b", role: "viewer", displayName: "Workspace B member", email: "b@example.test" };
    let finishChange: ((value: WorkspaceMember) => void) | undefined;
    apiClient.workspaces = async () => [{ ...workspace, memberRole: "admin", capabilities: { canCreateProject: true, canManageMembers: true } }, secondWorkspace];
    apiClient.workspaceMembers = async (requestedWorkspaceId) => requestedWorkspaceId === workspace.id ? [firstMember] : [secondMember];
    apiClient.changeWorkspaceMember = async () => new Promise((resolve) => { finishChange = resolve; });
    try {
      const view = render(<WorkspaceMembersPage workspaceId={workspace.id} />);
      fireEvent.click(await screen.findByRole("combobox", { name: "Role for Workspace A member" }));
      fireEvent.click(await screen.findByRole("option", { name: "Admin" }));
      await waitFor(() => assert.ok(finishChange));

      view.rerender(<WorkspaceMembersPage workspaceId={secondWorkspace.id} />);
      await screen.findByText("Workspace B member");
      await act(async () => finishChange!({ ...firstMember, role: "admin" }));
      assert.ok(screen.getByText("Workspace B member"));
      assert.equal(screen.queryByText("Workspace A member"), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("persists a project pin through the product API", async () => {
    const original = { workspaces: apiClient.workspaces, setProjectPinned: apiClient.setProjectPinned };
    const project = { id: "project_1", workspaceId: workspace.id, name: "Pinned project", pinnedAt: null, taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp };
    const mutations: Array<[string, boolean]> = [];
    apiClient.workspaces = async () => [{ ...workspace, projects: [project] }];
    apiClient.setProjectPinned = async (projectId, pinned) => { mutations.push([projectId, pinned]); return { ...project, pinnedAt: pinned ? timestamp : null }; };
    try {
      render(<AppRouterContext.Provider value={router()}><WorkspaceProjectsEntryPage workspaceId={workspace.id} /></AppRouterContext.Provider>);
      const pin = (await screen.findAllByRole("button", { name: "Pin Pinned project" }))[0]!;
      fireEvent.click(pin);
      await waitFor(() => assert.deepEqual(mutations, [[project.id, true]]));
      assert.ok((await screen.findAllByRole("button", { name: "Unpin Pinned project" })).length > 0);
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps the current project order when a pin fails and retries in place", async () => {
    const original = { workspaces: apiClient.workspaces, setProjectPinned: apiClient.setProjectPinned };
    const project = { id:"project_retry",workspaceId:workspace.id,name:"Retry project",pinnedAt:null,taskConcurrencyLimit:2,createdAt:timestamp,updatedAt:timestamp };
    let attempts=0;
    apiClient.workspaces=async()=>[{...workspace,projects:[project]}];
    apiClient.setProjectPinned=async()=>{attempts+=1;if(attempts===1)throw new ApiError(503,"Pin service unavailable.");return{...project,pinnedAt:timestamp}};
    try{
      render(<AppRouterContext.Provider value={router()}><WorkspaceProjectsEntryPage workspaceId={workspace.id}/></AppRouterContext.Provider>);
      fireEvent.click((await screen.findAllByRole("button",{name:"Pin Retry project"}))[0]!);
      const alert=await screen.findByRole("alert");
      assert.ok(alert.textContent?.includes("Pin service unavailable."));
      assert.ok(screen.getAllByRole("button",{name:"Pin Retry project"}).length>0);
      fireEvent.click(within(alert).getByRole("button",{name:"Retry"}));
      await waitFor(()=>assert.equal(attempts,2));
      assert.ok((await screen.findAllByRole("button",{name:"Unpin Retry project"})).length>0);
    }finally{Object.assign(apiClient,original)}
  });

  it("locks every project pin while a pin update is in flight", async () => {
    const original = { workspaces: apiClient.workspaces, setProjectPinned: apiClient.setProjectPinned };
    const first = { id:"project_pin_first",workspaceId:workspace.id,name:"First project",pinnedAt:null,taskConcurrencyLimit:2,createdAt:timestamp,updatedAt:timestamp };
    const second = { ...first, id:"project_pin_second", name:"Second project" };
    let finish!: (value: typeof first) => void;
    apiClient.workspaces = async () => [{ ...workspace, projects:[first,second] }];
    apiClient.setProjectPinned = async () => new Promise((resolve) => { finish = resolve; });
    try {
      render(<AppRouterContext.Provider value={router()}><WorkspaceProjectsEntryPage workspaceId={workspace.id} /></AppRouterContext.Provider>);
      fireEvent.click((await screen.findAllByRole("button", { name:"Pin First project" }))[0]!);
      await waitFor(() => assert.ok(finish));

      for (const name of ["Pin First project", "Pin Second project"]) {
        for (const button of screen.getAllByRole("button", { name })) assert.equal((button as HTMLButtonElement).disabled, true);
      }

      await act(async () => finish({ ...first, pinnedAt:timestamp }));
    } finally { Object.assign(apiClient,original); }
  });

  it("enters a project immediately after creating it", async () => {
    const original = { workspaces: apiClient.workspaces, createProject: apiClient.createProject };
    const pushed: string[] = [];
    const created = { id: "project_new", workspaceId: workspace.id, name: "New project", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp };
    apiClient.workspaces = async () => [{ ...workspace, capabilities: { canCreateProject: true, canManageMembers: true } }];
    apiClient.createProject = async () => created;
    try {
      render(<AppRouterContext.Provider value={router(pushed)}><WorkspaceProjectsEntryPage workspaceId={workspace.id} /></AppRouterContext.Provider>);
      fireEvent.click(await within(screen.getByTestId("page-layout__header")).findByRole("button", { name: "New project" }));
      fireEvent.change(screen.getByLabelText("Project name"), { target: { value: created.name } });
      fireEvent.click(screen.getByRole("button", { name: "Create project" }));
      await waitFor(() => assert.deepEqual(pushed, [`/workspaces/${workspace.id}/projects/${created.id}/overview`]));
    } finally { Object.assign(apiClient, original); }
  });

  it("does not enter a project created for a workspace the user has left", async () => {
    const original = { workspaces: apiClient.workspaces, createProject: apiClient.createProject };
    const pushed: string[] = [];
    const first = { ...workspace, capabilities: { canCreateProject: true, canManageMembers: true } };
    const second = { ...first, id: "workspace_2", name: "Second workspace", projects: [] };
    const created = { id: "project_late", workspaceId: workspace.id, name: "Late project", taskConcurrencyLimit: 2, createdAt: timestamp, updatedAt: timestamp };
    let finishCreate!: (value: typeof created) => void;
    let createStarted = false;
    apiClient.workspaces = async () => [first, second];
    apiClient.createProject = async () => { createStarted = true; return new Promise((resolve) => { finishCreate = resolve; }); };
    try {
      const view = render(<AppRouterContext.Provider value={router(pushed)}><WorkspaceProjectsEntryPage workspaceId={workspace.id} /></AppRouterContext.Provider>);
      fireEvent.click(await within(screen.getByTestId("page-layout__header")).findByRole("button", { name: "New project" }));
      fireEvent.change(screen.getByLabelText("Project name"), { target: { value: created.name } });
      fireEvent.click(screen.getByRole("button", { name: "Create project" }));
      await waitFor(() => assert.equal(createStarted, true));
      view.rerender(<AppRouterContext.Provider value={router(pushed)}><WorkspaceProjectsEntryPage workspaceId={second.id} /></AppRouterContext.Provider>);
      await screen.findByRole("heading", { name: second.name });
      await act(async () => finishCreate(created));
      assert.deepEqual(pushed, []);
      assert.ok(screen.getByRole("heading", { name: second.name }));
    } finally { Object.assign(apiClient, original); }
  });

  it("confirms before removing a workspace member", async () => {
    const original = { workspaces: apiClient.workspaces, workspaceMembers: apiClient.workspaceMembers, removeWorkspaceMember: apiClient.removeWorkspaceMember };
    const member: WorkspaceMember = { workspaceId: workspace.id, userId: "member_1", role: "member", displayName: "Member Person", email: "member@example.test", createdAt: timestamp, updatedAt: timestamp };
    const removed: string[] = [];
    apiClient.workspaces = async () => [{ ...workspace, memberRole: "admin", capabilities: { canCreateProject: true, canManageMembers: true } }];
    apiClient.workspaceMembers = async () => [owner, member];
    apiClient.removeWorkspaceMember = async (_workspaceId, userId) => { removed.push(userId); return { deleted: true }; };
    try {
      render(<WorkspaceMembersPage workspaceId={workspace.id} />);
      fireEvent.click(await screen.findByRole("button", { name: "Remove Member Person" }));
      assert.deepEqual(removed, []);
      assert.ok(screen.getByRole("alertdialog", { name: "Remove workspace member" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove member" }));
      await waitFor(() => assert.deepEqual(removed, [member.userId]));
    } finally { Object.assign(apiClient, original); }
  });
});

function router(pushed: string[] = []) { return { back() {}, forward() {}, refresh() {}, push(path: string) { pushed.push(path); }, replace() {}, prefetch() {} }; }

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, { hasPointerCapture() { return false; }, setPointerCapture() {}, releasePointerCapture() {}, scrollIntoView() {} });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
