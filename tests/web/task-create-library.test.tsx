import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { after, afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type Endpoint, type FileLibrary } from "../../src/lib/api/client.js";
import type { TaskCreateValue } from "../../src/components/tasks/TaskCreateDialog.js";

const dom = installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { TaskCreateDialog } = await import("../../src/components/tasks/TaskCreateDialog.js");
const { TasksPageContent } = await import("../../src/components/tasks/TasksPage.js");

afterEach(() => cleanup());
after(() => { cleanup(); dom.window.close(); });

describe("task File Library creation", () => {
  it("creates a new library by default with an editable generated name", async () => {
    let submitted: TaskCreateValue | undefined;
    render(<TaskCreateDialog endpoints={[endpoint]} libraries={[]} librariesLoading={false} open saving={false} onClose={() => undefined} onCreate={async (input) => { submitted = input; }} />);

    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), { target: { value: "Release notes" } });
    assert.equal((screen.getByRole("textbox", { name: "Library name" }) as HTMLInputElement).value, "Release notes workspace");
    fireEvent.change(screen.getByRole("textbox", { name: "Library name" }), { target: { value: "Release source" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "Prepare notes" } });
    fireEvent.submit(screen.getByRole("form", { name: "Create task" }));

    await waitFor(() => assert.ok(submitted));
    assert.deepEqual(submitted?.fileLibrary, { mode: "create_new", name: "Release source" });
  });

  it("creates from an authorized unbound existing library only", async () => {
    let submitted: TaskCreateValue | undefined;
    const libraries = [
      library("available", null, { canDelete:false, canWriteFiles:true }),
      library("bound", { id:"task_2",title:"Bound" }, { canDelete:true, canWriteFiles:true }),
      library("read-only", null, { canDelete:true, canWriteFiles:false })
    ];
    render(<TaskCreateDialog endpoints={[endpoint]} libraries={libraries} librariesLoading={false} open saving={false} onClose={() => undefined} onCreate={async (input) => { submitted = input; }} />);

    fireEvent.click(screen.getByRole("radio", { name: /Use existing library/ }));
    assert.equal(screen.getByRole("combobox", { name: "Existing File Library" }).textContent, "available");
    assert.equal(screen.queryByText("bound"), null);
    assert.equal(screen.queryByText("read-only"), null);
    fireEvent.change(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "Use the files" } });
    fireEvent.submit(screen.getByRole("form", { name: "Create task" }));

    await waitFor(() => assert.ok(submitted));
    assert.deepEqual(submitted?.fileLibrary, { mode: "use_existing", id: "available" });
  });

  it("refreshes libraries after a binding conflict without losing the draft", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities, fileLibraries: apiClient.fileLibraries, createTask: apiClient.createTask };
    let libraryReads = 0;
    apiClient.tasks = async () => ({ items: [], nextCursor: null, total: 0 });
    apiClient.endpoints = async () => [endpoint];
    apiClient.projectCapabilities = async () => ({ canManageEndpoints:true, canManageMembers:true, canManagePolicy:true, canWriteFiles:true, canCreateTasks:true });
    apiClient.fileLibraries = async () => ++libraryReads === 1 ? [library("available", null, { canDelete:false,canWriteFiles:true })] : [];
    apiClient.createTask = async () => { throw new ApiError(409, "Server wording can change", "file_library_already_bound"); };
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
      fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), { target: { value: "Keep title" } });
      fireEvent.click(screen.getByRole("radio", { name: /Use existing library/ }));
      fireEvent.change(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "Keep prompt" } });
      fireEvent.submit(screen.getByRole("form", { name: "Create task" }));

      await screen.findByText("Server wording can change");
      await waitFor(() => assert.equal(libraryReads, 2));
      assert.equal((screen.getByRole("textbox", { name: /Title/ }) as HTMLInputElement).value, "Keep title");
      assert.equal((screen.getByRole("textbox", { name: "Task prompt" }) as HTMLTextAreaElement).value, "Keep prompt");
    } finally { Object.assign(apiClient, original); }
  });

  it("refreshes libraries after a name conflict without losing the draft", async () => {
    const original = { tasks:apiClient.tasks, endpoints:apiClient.endpoints, projectCapabilities:apiClient.projectCapabilities, fileLibraries:apiClient.fileLibraries, createTask:apiClient.createTask };
    let libraryReads = 0;
    apiClient.tasks = async () => ({ items:[], nextCursor:null, total:0 });
    apiClient.endpoints = async () => [endpoint];
    apiClient.projectCapabilities = async () => ({ canManageEndpoints:true, canManageMembers:true, canManagePolicy:true, canWriteFiles:true, canCreateTasks:true });
    apiClient.fileLibraries = async () => { libraryReads += 1; return []; };
    apiClient.createTask = async () => { throw new ApiError(409, "Different conflict wording", "file_library_name_conflict"); };
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      fireEvent.click(await screen.findByRole("button", { name:"Create task" }));
      fireEvent.change(screen.getByRole("textbox", { name:/Title/ }), { target:{ value:"Keep title" } });
      fireEvent.change(screen.getByRole("textbox", { name:"Library name" }), { target:{ value:"Existing name" } });
      fireEvent.change(screen.getByRole("textbox", { name:"Task prompt" }), { target:{ value:"Keep prompt" } });
      fireEvent.submit(screen.getByRole("form", { name:"Create task" }));

      await screen.findByText("Different conflict wording");
      await waitFor(() => assert.equal(libraryReads, 2));
      assert.equal((screen.getByRole("textbox", { name:"Library name" }) as HTMLInputElement).value, "Existing name");
      assert.equal((screen.getByRole("textbox", { name:"Task prompt" }) as HTMLTextAreaElement).value, "Keep prompt");
    } finally { Object.assign(apiClient, original); }
  });
});

const endpoint: Endpoint = { id:"endpoint_1",projectId:"project_1",name:"Endpoint",protocol:"openai_chat_completions",baseUrl:"https://example.test/v1",model:"model",credentialId:"credential_1",capabilities:["text","tool_calls"],requestTimeoutSecs:30,hasCredentialRef:true,taskEligible:true,createdAt:"x",updatedAt:"x" };

function library(id: string, boundTask: FileLibrary["boundTask"], capabilities: { canDelete:boolean; canWriteFiles:boolean }): FileLibrary {
  return { id, workspaceId:"workspace_1", projectId:"project_1", name:id, rootSubPath:`libraries/${id}/home`, createdByUserId:"user_1", createdAt:"x", updatedAt:"x", boundTask, capabilities:{ canRename:capabilities.canDelete, ...capabilities } };
}

function installDom(): JSDOM {
  const instance = new JSDOM("<!doctype html><html><body></body></html>", { url:"http://localhost/workspaces/workspace_1/projects/project_1/tasks" });
  Object.assign(globalThis, { window:instance.window, document:instance.window.document, HTMLElement:instance.window.HTMLElement, HTMLInputElement:instance.window.HTMLInputElement, HTMLTextAreaElement:instance.window.HTMLTextAreaElement, HTMLFormElement:instance.window.HTMLFormElement, Element:instance.window.Element, DocumentFragment:instance.window.DocumentFragment, Node:instance.window.Node, NodeFilter:instance.window.NodeFilter, self:instance.window, Event:instance.window.Event, CustomEvent:instance.window.CustomEvent, MutationObserver:instance.window.MutationObserver, getComputedStyle:instance.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT:true });
  Object.defineProperty(globalThis, "navigator", { configurable:true, value:instance.window.navigator });
  Object.assign(instance.window, { PointerEvent:instance.window.MouseEvent });
  Object.assign(globalThis, { PointerEvent:instance.window.PointerEvent });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver:class { observe() {} unobserve() {} disconnect() {} } });
  return instance;
}
