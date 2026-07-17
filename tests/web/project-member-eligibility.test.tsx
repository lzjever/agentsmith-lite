import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type ProjectCapabilities, type ProjectMember, type WorkspaceMember } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { MembersPage } = await import("../../src/components/members/MembersPage.js");

const projectId = "project_1";
const workspaceId = "workspace_1";
const timestamp = "2026-07-12T00:00:00.000Z";
const capabilities: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: true, canManagePolicy: false, canWriteFiles: false, canCreateTasks: false, canCancelTasks: false, canSendChat: false };
const owner: ProjectMember = { projectId, userId: "owner_1", role: "owner", displayName: "Owner", email: "owner@example.test", createdAt: timestamp, updatedAt: timestamp };
const workspaceOwner: WorkspaceMember = { workspaceId, userId: owner.userId, role: "owner", displayName: owner.displayName, email: owner.email, createdAt: timestamp, updatedAt: timestamp };
const candidate: WorkspaceMember = { workspaceId, userId: "candidate_1", role: "member", displayName: "Candidate Person", email: "candidate@example.test", createdAt: timestamp, updatedAt: timestamp };

afterEach(() => cleanup());

describe("project member eligibility", () => {
  it("serializes project membership mutations", async () => {
    const original = snapshotClient();
    const first: ProjectMember = { ...owner, userId: "member_1", role: "member", displayName: "First member", email: "first@example.test" };
    const second: ProjectMember = { ...owner, userId: "member_2", role: "viewer", displayName: "Second member", email: "second@example.test" };
    let changes = 0;
    apiClient.members = async () => [owner, first, second];
    apiClient.workspaceMembers = async () => [workspaceOwner];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.changeMember = async () => { changes++; return new Promise(() => undefined); };
    try {
      render(<MembersPage workspaceId={workspaceId} projectId={projectId} />);
      const firstRole = (await screen.findAllByRole("combobox", { name: "Role for First member" }))[0]!;
      fireEvent.click(firstRole);
      fireEvent.click(await screen.findByRole("option", { name: "Admin" }));
      await waitFor(() => assert.equal(changes, 1));
      assert.equal(screen.queryByRole("dialog", { name: "Member details" }), null);
      for (const control of screen.getAllByRole("combobox", { name: "Role for First member" })) {
        assert.equal((control as HTMLButtonElement).disabled, true);
      }
      for (const control of screen.getAllByRole("combobox", { name: "Role for Second member" })) {
        assert.equal((control as HTMLButtonElement).disabled, true);
      }
      assert.equal(screen.getAllByRole("button", { name: "Remove First member" }).length, 2);
    } finally { restoreClient(original); }
  });

  it("does not apply a role change after switching projects", async () => {
    const original = snapshotClient();
    const first: ProjectMember = { ...owner, userId: "member_a", role: "member", displayName: "Project A member", email: "a@example.test" };
    const second: ProjectMember = { ...owner, projectId: "project_2", userId: "member_b", role: "viewer", displayName: "Project B member", email: "b@example.test" };
    let finishChange: ((value: ProjectMember) => void) | undefined;
    apiClient.members = async (requestedProjectId) => requestedProjectId === "project_1" ? [first] : [second];
    apiClient.workspaceMembers = async () => [];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.changeMember = async () => new Promise((resolve) => { finishChange = resolve; });
    try {
      const view = render(<MembersPage workspaceId="workspace_1" projectId="project_1" />);
      const roleControl = (await screen.findAllByRole("combobox", { name: "Role for Project A member" }))[0]!;
      fireEvent.click(roleControl);
      fireEvent.click(await screen.findByRole("option", { name: "Admin" }));
      await waitFor(() => assert.ok(finishChange));

      view.rerender(<MembersPage workspaceId="workspace_2" projectId="project_2" />);
      assert.ok((await screen.findAllByText("Project B member")).length > 0);
      await act(async () => finishChange!({ ...first, role: "admin" }));
      assert.ok(screen.getAllByText("Project B member").length > 0);
      assert.equal(screen.queryAllByText("Project A member").length, 0);
    } finally { restoreClient(original); }
  });

  it("adds a selected workspace member by stable user ID", async () => {
    const original = snapshotClient();
    let projectMembers = [owner];
    const additions: Array<{ userId: string; role: string }> = [];
    apiClient.members = async () => projectMembers;
    apiClient.workspaceMembers = async () => [workspaceOwner, candidate];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.addMember = async (_projectId, userId, role) => {
      additions.push({ userId, role });
      const added: ProjectMember = { ...candidate, projectId, role };
      projectMembers = [owner, added];
      return added;
    };
    try {
      render(<MembersPage workspaceId={workspaceId} projectId={projectId} />);
      await screen.findAllByText("Owner");
      fireEvent.click(screen.getByRole("button", { name: "Add member" }));
      assert.equal(screen.queryByRole("textbox", { name: "Email" }), null);
      fireEvent.click(screen.getByRole("combobox", { name: "Workspace member" }));
      fireEvent.click(await screen.findByRole("option", { name: "Candidate Person" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Add member" }).at(-1)!);
      await waitFor(() => assert.deepEqual(additions, [{ userId: candidate.userId, role: "member" }]));
      await screen.findAllByText("Candidate Person");
    } finally { restoreClient(original); }
  });

  it("reuses a project member creation key after an unknown network result", async () => {
    const original = snapshotClient();
    const keys: string[] = [];
    let attempts = 0;
    apiClient.members = async () => [owner];
    apiClient.workspaceMembers = async () => [workspaceOwner, candidate];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.addMember = (async (_projectId:string,userId:string,role:"member",key:string)=>{keys.push(key);if(++attempts===1)throw new Error("connection closed");return {...candidate,projectId,userId,role};}) as typeof apiClient.addMember;
    try {
      render(<MembersPage workspaceId={workspaceId} projectId={projectId} />);
      fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
      fireEvent.click(screen.getByRole("combobox", { name: "Workspace member" }));
      fireEvent.click(await screen.findByRole("option", { name: "Candidate Person" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Add member" }).at(-1)!);
      await waitFor(() => assert.equal(attempts, 1));
      fireEvent.click(screen.getAllByRole("button", { name: "Add member" }).at(-1)!);
      await waitFor(() => assert.equal(attempts, 2));
      assert.ok(keys[0]);
      assert.equal(keys[1], keys[0]);
    } finally { restoreClient(original); }
  });

  it("closes member mutations when the project becomes read-only", async () => {
    const original = snapshotClient();
    apiClient.members = async () => [owner];
    apiClient.workspaceMembers = async () => [workspaceOwner, candidate];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.addMember = async () => { throw new ApiError(409, "Project is archived"); };
    try {
      render(<MembersPage workspaceId={workspaceId} projectId={projectId} />);
      fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
      fireEvent.click(screen.getByRole("combobox", { name: "Workspace member" }));
      fireEvent.click(await screen.findByRole("option", { name: "Candidate Person" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Add member" }).at(-1)!);
      await screen.findByText("Member management access changed. Members are now read-only.");
      assert.equal(screen.queryByRole("dialog", { name: "Add member" }), null);
      assert.equal(screen.queryByRole("button", { name: "Add member" }), null);
    } finally { restoreClient(original); }
  });

  it("clears the member directory when a mutation discovers project access was removed", async () => {
    const original = snapshotClient();
    apiClient.members = async () => [owner];
    apiClient.workspaceMembers = async () => [workspaceOwner, candidate];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.addMember = async () => { throw new ApiError(403, "Project access denied"); };
    try {
      render(<MembersPage workspaceId={workspaceId} projectId={projectId} />);
      fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
      fireEvent.click(screen.getByRole("combobox", { name: "Workspace member" }));
      fireEvent.click(await screen.findByRole("option", { name: "Candidate Person" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Add member" }).at(-1)!);

      await screen.findByRole("heading", { name: "Members unavailable" });
      assert.equal(screen.queryByText("Owner"), null);
      assert.equal(screen.queryByRole("dialog", { name: "Add member" }), null);
    } finally { restoreClient(original); }
  });

  it("explains when every workspace member already has project access", async () => {
    const original = snapshotClient();
    apiClient.members = async () => [owner];
    apiClient.workspaceMembers = async () => [workspaceOwner];
    apiClient.projectCapabilities = async () => capabilities;
    try {
      render(<MembersPage workspaceId={workspaceId} projectId={projectId} />);
      await screen.findByText("All workspace members already have project access.");
      assert.equal(screen.queryByRole("button", { name: "Add member" }), null);
      assert.equal(screen.getByRole("link", { name: "Manage workspace members" }).getAttribute("href"), `/workspaces/${workspaceId}/members`);
    } finally { restoreClient(original); }
  });

  it("keeps existing members usable when workspace candidates cannot be loaded", async () => {
    const original = snapshotClient();
    apiClient.members = async () => [owner];
    apiClient.workspaceMembers = async () => { throw new Error("offline"); };
    apiClient.projectCapabilities = async () => capabilities;
    try {
      render(<MembersPage workspaceId={workspaceId} projectId={projectId} />);
      await screen.findAllByText("Owner");
      assert.ok(screen.getByRole("alert").textContent?.includes("Workspace members could not be loaded"));
      assert.equal(screen.queryByRole("heading", { name: "Members unavailable" }), null);
      assert.equal(screen.getByRole("link", { name: "Manage workspace members" }).getAttribute("href"), `/workspaces/${workspaceId}/members`);
    } finally { restoreClient(original); }
  });

  it("keeps the member directory readable and skips candidates when permissions cannot be loaded", async () => {
    const original = snapshotClient();
    let candidateReads = 0;
    apiClient.members = async () => [owner];
    apiClient.workspaceMembers = async () => { candidateReads += 1; return [workspaceOwner, candidate]; };
    apiClient.projectCapabilities = async () => { throw new ApiError(503, "Permissions unavailable"); };
    try {
      render(<MembersPage workspaceId={workspaceId} projectId={projectId} />);
      await screen.findAllByText("Owner");
      assert.match(screen.getByRole("alert").textContent ?? "", /read-only until refreshed/i);
      assert.equal(screen.queryByRole("heading", { name: "Members unavailable" }), null);
      assert.equal(screen.queryByRole("button", { name: "Add member" }), null);
      assert.equal(candidateReads, 0);
    } finally { restoreClient(original); }
  });

  it("reconciles a role change when the response is lost after commit", async () => {
    const original = snapshotClient();
    const member: ProjectMember = { ...owner, userId: "member_1", role: "member", displayName: "Member One", email: "member@example.test" };
    let listed = [owner, member];
    apiClient.members = async () => listed;
    apiClient.workspaceMembers = async () => [workspaceOwner];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.changeMember = async () => { listed = [owner, { ...member, role: "admin" }]; throw new ApiError(503, "Response lost"); };
    try {
      render(<MembersPage workspaceId={workspaceId} projectId={projectId} />);
      const roleControl = (await screen.findAllByRole("combobox", { name: "Role for Member One" }))[0]!;
      fireEvent.click(roleControl);
      fireEvent.click(await screen.findByRole("option", { name: "Admin" }));
      await waitFor(() => assert.match(screen.getAllByRole("combobox", { name: "Role for Member One" })[0]!.textContent ?? "", /Admin/));
      assert.equal(screen.queryByText("Response lost"), null);
    } finally { restoreClient(original); }
  });

  it("reconciles a removal when the response is lost after commit", async () => {
    const original = snapshotClient();
    const member: ProjectMember = { ...owner, userId: "member_1", role: "member", displayName: "Member One", email: "member@example.test" };
    let listed = [owner, member];
    apiClient.members = async () => listed;
    apiClient.workspaceMembers = async () => [workspaceOwner, { ...candidate, userId: member.userId, displayName: member.displayName, email: member.email }];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.removeMember = async () => { listed = [owner]; throw new ApiError(503, "Response lost"); };
    try {
      render(<MembersPage workspaceId={workspaceId} projectId={projectId} />);
      fireEvent.click((await screen.findAllByRole("button", { name: "Remove Member One" }))[0]!);
      const dialog = await screen.findByRole("alertdialog", { name: "Remove member" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove member" }));
      await waitFor(() => assert.equal(screen.queryByText("Member One"), null));
      assert.equal(screen.queryByRole("alertdialog", { name: "Remove member" }), null);
    } finally { restoreClient(original); }
  });
});

function snapshotClient() { return { members: apiClient.members, workspaceMembers: apiClient.workspaceMembers, projectCapabilities: apiClient.projectCapabilities, addMember: apiClient.addMember, changeMember: apiClient.changeMember, removeMember: apiClient.removeMember }; }
function restoreClient(original: ReturnType<typeof snapshotClient>) { Object.assign(apiClient, original); }
function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, self: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, { hasPointerCapture() { return false; }, setPointerCapture() {}, releasePointerCapture() {}, scrollIntoView() {} });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
