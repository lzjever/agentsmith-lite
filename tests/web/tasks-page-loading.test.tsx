import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type Endpoint, type ProjectCapabilities, type Task } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { TasksPageContent } = await import("../../src/components/tasks/TasksPage.js");

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("tasks page loading", () => {
  it("uses the task list URL as the filter source and restores it on browser navigation", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities };
    const calls: Array<Parameters<typeof apiClient.tasks>[1]> = [];
    apiClient.tasks = async (_projectId, query) => { calls.push(query); return { items: [], total: 0, nextCursor: null }; };
    apiClient.endpoints = async () => [];
    apiClient.projectCapabilities = async () => ({ canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: false, canCreateTasks: false, canCancelTasks: false, canSendChat: false });
    window.history.replaceState(null, "", "/workspaces/workspace_1/projects/project_1/tasks?status=failed&archived=include&sort=title&direction=asc&search=release");
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      await waitFor(() => assert.equal(calls.length, 1));
      assert.deepEqual(calls[0], { statuses: ["failed"], archived: "include", sort: "title", direction: "asc", search: "release", limit: 25 });

      window.history.replaceState(null, "", "/workspaces/workspace_1/projects/project_1/tasks?status=running");
      await act(async () => window.dispatchEvent(new window.PopStateEvent("popstate")));
      await waitFor(() => assert.equal(calls.at(-1)?.statuses?.[0], "running"));
      assert.deepEqual(calls.at(-1), { statuses: ["running"], archived: "exclude", sort: "updated_at", direction: "desc", limit: 25 });
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("writes task search changes to the URL and omits default filters", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities };
    apiClient.tasks = async () => ({ items: [], total: 0, nextCursor: null });
    apiClient.endpoints = async () => [];
    apiClient.projectCapabilities = async () => ({ canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: false, canCreateTasks: false, canCancelTasks: false, canSendChat: false });
    window.history.replaceState(null, "", "/workspaces/workspace_1/projects/project_1/tasks?status=unknown&sort=title&direction=desc");
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      await screen.findByText("No tasks yet");
      assert.equal(window.location.search, "");
      const historyLength = window.history.length;

      fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "  incident  " } });
      fireEvent.click(screen.getByRole("button", { name: "Apply task search" }));
      await waitFor(() => assert.equal(window.location.search, "?search=incident"));
      assert.equal(window.history.length, historyLength + 1);

      await act(async () => {
        const wentBack = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
        window.history.back();
        await wentBack;
      });
      await waitFor(() => assert.equal(window.location.search, ""));
      assert.equal((screen.getByRole("textbox", { name: "Search tasks" }) as HTMLInputElement).value, "");
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("links managers to endpoint configuration when task creation is blocked", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities };
    apiClient.tasks = async () => ({ items: [], total: 0, nextCursor: null });
    apiClient.endpoints = async () => [];
    apiClient.projectCapabilities = async () => ({ canManageEndpoints: true, canManageMembers: true, canManagePolicy: true, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true });
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      await screen.findByText("Add an endpoint with text and tool-call support before creating a task.");
      assert.equal(screen.getByRole("link", { name: "Open endpoints" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/endpoints");
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("explains when configured endpoints need a successful health check", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities };
    const unavailable: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Task endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, health: { status: "unavailable", checkedAt: task.updatedAt, errorCategory: "auth" }, hasCredentialRef: true, taskEligible: false, createdAt: task.createdAt, updatedAt: task.updatedAt };
    apiClient.tasks = async () => ({ items: [], total: 0, nextCursor: null });
    apiClient.endpoints = async () => [unavailable];
    apiClient.projectCapabilities = async () => ({ canManageEndpoints: true, canManageMembers: true, canManagePolicy: true, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true });
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      await screen.findByText("Check endpoint health successfully before creating a task.");
      assert.equal(screen.queryByText("Add an endpoint with text and tool-call support before creating a task."), null);
      assert.equal(screen.getByRole("link", { name: "Open endpoints" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/endpoints");
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("starts from the first task page after switching projects", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities };
    const calls: Array<{ projectId: string; cursor?: string }> = [];
    const secondProjectTask = { ...task, id: "task_2", projectId: "project_2", prompt: "Project two task" };
    const readOnly: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: false, canCreateTasks: false, canCancelTasks: false, canSendChat: false };
    apiClient.tasks = async (projectId, query) => {
      calls.push({ projectId, ...(query.cursor ? { cursor: query.cursor } : {}) });
      if (projectId === "project_2") return { items: [secondProjectTask], total: 1, nextCursor: null };
      return { items: [task], total: 2, nextCursor: query.cursor ? null : "project_1_cursor" };
    };
    apiClient.endpoints = async () => [];
    apiClient.projectCapabilities = async () => readOnly;
    try {
      const view = render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      fireEvent.click(await screen.findByRole("button", { name: "Next task page" }));
      await waitFor(() => assert.ok(calls.some((call) => call.projectId === "project_1" && call.cursor === "project_1_cursor")));

      view.rerender(<TasksPageContent workspaceId="workspace_1" projectId="project_2" navigate={() => undefined} />);
      await screen.findByRole("link", { name: /Project two task/ });
      const projectTwoCall = calls.find((call) => call.projectId === "project_2");
      assert.equal(projectTwoCall?.cursor, undefined);
      assert.equal(screen.getByRole("link", { name: /Project two task/ }).getAttribute("href"), "/workspaces/workspace_1/projects/project_2/tasks/task_2");
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("does not navigate to a task created for a project the user has left", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities, files: apiClient.files, createTask: apiClient.createTask };
    const eligible: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Task endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: task.createdAt, updatedAt: task.updatedAt };
    const manager: ProjectCapabilities = { canManageEndpoints: true, canManageMembers: true, canManagePolicy: true, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true };
    const readOnly = { ...manager, canCreateTasks: false, canWriteFiles: false };
    const navigations: string[] = [];
    let finishCreate!: (value: Task) => void;
    let createStarted = false;
    apiClient.tasks = async () => ({ items: [], total: 0, nextCursor: null });
    apiClient.endpoints = async (projectId) => projectId === "project_1" ? [eligible] : [];
    apiClient.projectCapabilities = async (projectId) => projectId === "project_1" ? manager : readOnly;
    apiClient.files = async () => ({ entries: [] });
    apiClient.createTask = async () => { createStarted = true; return new Promise((resolve) => { finishCreate = resolve; }); };
    try {
      const view = render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={(path) => navigations.push(path)} />);
      fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "Run in project one" } });
      fireEvent.submit(screen.getByRole("form", { name: "Create task" }));
      await waitFor(() => assert.equal(createStarted, true));

      view.rerender(<TasksPageContent workspaceId="workspace_1" projectId="project_2" navigate={(path) => navigations.push(path)} />);
      await screen.findByText("Your project access is read-only.");
      await act(async () => finishCreate(task));
      assert.deepEqual(navigations, []);
      assert.equal(screen.queryByRole("form", { name: "Create task" }), null);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("uses a new task creation key after a definitive API failure", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities, files: apiClient.files, createTask: apiClient.createTask };
    const eligible: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Task endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: task.createdAt, updatedAt: task.updatedAt };
    const manager: ProjectCapabilities = { canManageEndpoints: true, canManageMembers: true, canManagePolicy: true, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true };
    const keys: string[] = [];
    const navigations: string[] = [];
    apiClient.tasks = async () => ({ items: [], total: 0, nextCursor: null });
    apiClient.endpoints = async () => [eligible];
    apiClient.projectCapabilities = async () => manager;
    apiClient.files = async () => ({ entries: [] });
    apiClient.createTask = async (_projectId, _input, key) => {
      keys.push(key);
      if (keys.length === 1) throw new ApiError(409, "Project active tasks limit reached", "active_tasks_limit_reached");
      return task;
    };
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={(path) => navigations.push(path)} />);
      fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "Run after capacity is released" } });
      fireEvent.submit(screen.getByRole("form", { name: "Create task" }));
      await waitFor(() => assert.equal(keys.length, 1));
      assert.match(screen.getByRole("alert").textContent ?? "", /Wait for or cancel an active task/);
      assert.equal(screen.getByRole("link", { name: "Open resource policy" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/policy");

      fireEvent.submit(screen.getByRole("form", { name: "Create task" }));
      await waitFor(() => assert.deepEqual(navigations, ["/workspaces/workspace_1/projects/project_1/tasks/task_1"]));
      assert.equal(keys.length, 2);
      assert.notEqual(keys[0], keys[1]);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("refreshes task endpoints when the selected endpoint disappears", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities, files: apiClient.files, createTask: apiClient.createTask };
    const eligible: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Removed endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model-1", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: task.createdAt, updatedAt: task.updatedAt };
    const replacement: Endpoint = { ...eligible, id: "endpoint_2", name: "Replacement endpoint", model: "model-2", credentialId: "credential_2" };
    const manager: ProjectCapabilities = { canManageEndpoints: true, canManageMembers: true, canManagePolicy: true, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true };
    let endpointReads = 0;
    let finishEndpointRefresh!: (value: Endpoint[]) => void;
    apiClient.tasks = async () => ({ items: [], total: 0, nextCursor: null });
    apiClient.endpoints = async () => ++endpointReads === 1 ? [eligible] : new Promise((resolve) => { finishEndpointRefresh = resolve; });
    apiClient.projectCapabilities = async () => manager;
    apiClient.files = async () => ({ entries: [] });
    apiClient.createTask = async () => { throw new ApiError(404, "Endpoint not found"); };
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "Keep this task draft" } });
      fireEvent.submit(screen.getByRole("form", { name: "Create task" }));

      await waitFor(() => assert.equal(endpointReads, 2));
      assert.equal((screen.getByRole("button", { name: "Creating..." }) as HTMLButtonElement).disabled, true);
      await act(async () => finishEndpointRefresh([replacement]));
      assert.match(screen.getByRole("combobox").textContent ?? "", /Replacement endpoint \(model-2\)/);
      assert.equal((screen.getByRole("textbox", { name: "Task prompt" }) as HTMLTextAreaElement).value, "Keep this task draft");
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("closes task creation when the project is archived during creation", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities, files: apiClient.files, createTask: apiClient.createTask };
    const eligible: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Task endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: task.createdAt, updatedAt: task.updatedAt };
    const manager: ProjectCapabilities = { canManageEndpoints: true, canManageMembers: true, canManagePolicy: true, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true };
    let attempts = 0;
    apiClient.tasks = async () => ({ items: [task], total: 1, nextCursor: null });
    apiClient.endpoints = async () => [eligible];
    apiClient.projectCapabilities = async () => manager;
    apiClient.files = async () => ({ entries: [] });
    apiClient.createTask = async () => { attempts++; throw new ApiError(409, "Project is archived"); };
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "Run the task" } });
      await act(async () => { fireEvent.submit(screen.getByRole("form", { name: "Create task" })); await Promise.resolve(); });
      assert.equal(attempts, 1);
      assert.equal(screen.queryByRole("form", { name: "Create task" }), null);
      assert.equal(screen.queryByRole("button", { name: "Create task" }), null);
      assert.ok(screen.getByText("Your project access is read-only."));
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("keeps tasks readable when creation discovers write access was removed", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities, files: apiClient.files, createTask: apiClient.createTask };
    const eligible: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Task endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: task.createdAt, updatedAt: task.updatedAt };
    const manager: ProjectCapabilities = { canManageEndpoints: true, canManageMembers: true, canManagePolicy: true, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true };
    const readOnly: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: false, canCreateTasks: false, canCancelTasks: false, canSendChat: false };
    let capabilityReads = 0;
    apiClient.tasks = async () => ({ items: [task], total: 1, nextCursor: null });
    apiClient.endpoints = async () => [eligible];
    apiClient.projectCapabilities = async () => ++capabilityReads === 1 ? manager : readOnly;
    apiClient.files = async () => ({ entries: [] });
    apiClient.createTask = async () => { throw new ApiError(403, "Task creation is not allowed"); };
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "Run the task" } });
      await act(async () => { fireEvent.submit(screen.getByRole("form", { name: "Create task" })); await Promise.resolve(); });

      await screen.findByText("Your project access is read-only.");
      assert.ok(screen.getByRole("link", { name: /Prepare release notes/ }));
      assert.equal(screen.queryByRole("form", { name: "Create task" }), null);
      assert.equal(screen.queryByRole("button", { name: "Create task" }), null);
      assert.equal(capabilityReads, 2);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("clears tasks when creation discovers project access was removed", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities, files: apiClient.files, createTask: apiClient.createTask };
    const eligible: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Task endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: task.createdAt, updatedAt: task.updatedAt };
    const manager: ProjectCapabilities = { canManageEndpoints: true, canManageMembers: true, canManagePolicy: true, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true };
    let removed = false;
    apiClient.tasks = async () => {
      if (removed) throw new ApiError(403, "Project not found");
      return { items: [task], total: 1, nextCursor: null };
    };
    apiClient.endpoints = async () => [eligible];
    apiClient.projectCapabilities = async () => manager;
    apiClient.files = async () => ({ entries: [] });
    apiClient.createTask = async () => { removed = true; throw new ApiError(403, "Project not found"); };
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      fireEvent.click(await screen.findByRole("button", { name: "Create task" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "Run the task" } });
      await act(async () => { fireEvent.submit(screen.getByRole("form", { name: "Create task" })); await Promise.resolve(); });

      await screen.findByRole("button", { name: "Try again" });
      assert.equal(screen.queryByRole("link", { name: /Prepare release notes/ }), null);
      assert.equal(screen.queryByRole("form", { name: "Create task" }), null);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("keeps the newest endpoint and permission refresh for task creation", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities };
    const eligible: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Task endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: task.createdAt, updatedAt: task.updatedAt };
    const readOnly: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: false, canCreateTasks: false, canCancelTasks: false, canSendChat: false };
    let endpointReads = 0; let capabilityReads = 0;
    let resolveOldEndpoints!: (value: Endpoint[]) => void;
    let resolveOldCapabilities!: (value: ProjectCapabilities) => void;
    apiClient.tasks = async () => ({ items: [task], total: 1, nextCursor: null });
    apiClient.endpoints = async () => ++endpointReads === 1 ? new Promise((resolve) => { resolveOldEndpoints = resolve; }) : [];
    apiClient.projectCapabilities = async () => ++capabilityReads === 1 ? new Promise((resolve) => { resolveOldCapabilities = resolve; }) : readOnly;
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      await waitFor(() => assert.deepEqual([endpointReads, capabilityReads], [1, 1]));
      fireEvent.click(screen.getByRole("button", { name: "Refresh tasks" }));
      await screen.findByText("Your project access is read-only.");
      await act(async () => {
        resolveOldEndpoints([eligible]);
        resolveOldCapabilities({ ...readOnly, canCreateTasks: true });
        await Promise.resolve();
      });
      assert.equal(screen.queryByRole("button", { name: "Create task" }), null);
      assert.ok(screen.getByText("Your project access is read-only."));
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("keeps the task list readable when create-form dependencies fail", async () => {
    const original = { tasks: apiClient.tasks, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities };
    apiClient.tasks = async () => ({ items: [task], total: 1, nextCursor: null });
    apiClient.endpoints = async () => { throw new Error("Endpoints unavailable"); };
    apiClient.projectCapabilities = async () => { throw new Error("Permissions unavailable"); };
    try {
      render(<TasksPageContent workspaceId="workspace_1" projectId="project_1" navigate={() => undefined} />);
      const link = await screen.findByRole("link", { name: /Prepare release notes/ });
      assert.equal(link.getAttribute("href"), "/workspaces/workspace_1/projects/project_1/tasks/task_1");
      assert.ok(screen.getByText(/Endpoints unavailable.*Task creation is disabled/));
      assert.ok(screen.getByText(/Permissions unavailable.*Task creation is disabled/));
    } finally {
      Object.assign(apiClient, original);
    }
  });
});

const task: Task = {
  id: "task_1",
  workspaceId: "workspace_1",
  projectId: "project_1",
  endpointId: "endpoint_1",
  prompt: "Prepare release notes",
  status: "completed",
  runId: "run_1",
  executionMode: "live",
  sandbox: { namespace: "agentsmith" },
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:01:00.000Z"
};

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLFormElement: dom.window.HTMLFormElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {} });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
