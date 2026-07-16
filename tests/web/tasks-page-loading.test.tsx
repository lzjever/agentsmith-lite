import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { apiClient, type Endpoint, type ProjectCapabilities, type Task } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { TasksPageContent } = await import("../../src/components/tasks/TasksPage.js");

afterEach(() => cleanup());

describe("tasks page loading", () => {
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
  sandbox: { namespace: "agentsmith", resources: [] },
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
