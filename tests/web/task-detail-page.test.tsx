import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, it } from "node:test";
import React from "react";
import { apiClient, type ProjectCapabilities, type Task } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { TaskDetailPage } = await import("../../src/components/tasks/TaskDetailPage.js");

const capabilities: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: false, canCreateTasks: false, canCancelTasks: false, canSendChat: false };
const taskCreatorCapabilities: ProjectCapabilities = { ...capabilities, canCreateTasks: true };
const dryRunTask: Task = {
  id: "task_dry_run", workspaceId: "workspace_1", projectId: "project_1", endpointId: "endpoint_1", prompt: "Prepare a release note.", status: "running", runId: "run_dry_run", executionMode: "dry-run",
  sandbox: { namespace: "agentsmith", resources: [{ apiVersion: "v1", kind: "Pod", metadata: { name: "would-be-runner" } }] }, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z"
};

const originalTranscriptStream = apiClient.streamTaskTranscript;
const originalTaskInputs = apiClient.taskInputs;
beforeEach(() => { apiClient.streamTaskTranscript = async () => undefined; apiClient.taskInputs = async () => []; });
afterEach(() => { cleanup(); apiClient.streamTaskTranscript = originalTranscriptStream; apiClient.taskInputs = originalTaskInputs; });

describe("task detail execution mode", () => {
  it("uses the server-projected dry-run mode rather than inferring from resources or activity", async () => {
    const original = snapshotClient();
    apiClient.task = async () => dryRunTask;
    apiClient.taskEvents = async () => [];
    apiClient.taskArtifacts = async () => [];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.taskSummary = async () => ({ taskId: dryRunTask.id, eventCount: 0, artifactCount: 0, updatedAt: dryRunTask.updatedAt });
    apiClient.taskFollowUps = async () => [];
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={dryRunTask.id} />);
      await screen.findByRole("heading", { name: "Dry run" });
      assert.ok(screen.getByText("This task was created in dry-run mode. No sandbox resources, runtime events, or artifacts are expected."));
      assert.ok(screen.getByText(dryRunTask.prompt));
      assert.equal(screen.queryByRole("heading", { name: "Activity" }), null);
      assert.equal(screen.queryByText("Activity will appear as the task runs."), null);
    } finally {
      restoreClient(original);
    }
  });

  it("shows terminal follow-up linkage and starts a new task from terminal work", async () => {
    const original = snapshotClient();
    const terminal = { ...dryRunTask, status: "completed" as const, sourceTaskId: "task_source" };
    apiClient.task = async () => terminal;
    apiClient.taskEvents = async () => [];
    apiClient.taskArtifacts = async () => [];
    apiClient.projectCapabilities = async () => taskCreatorCapabilities;
    apiClient.taskSummary = async () => ({ taskId: terminal.id, eventCount: 1, artifactCount: 0, updatedAt: terminal.updatedAt });
    apiClient.taskFollowUps = async () => [{ id: "follow_1", taskId: terminal.id, prompt: "continue", followUpTaskId: "task_successor", createdAt: terminal.updatedAt }];
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={terminal.id} />);
      await screen.findByRole("button", { name: "Start follow-up" });
      assert.ok(screen.getByRole("button", { name: "Edit task title" }));
      assert.ok(screen.getByRole("button", { name: "Archive" }));
      assert.ok(screen.getByRole("button", { name: "Delete task" }));
      assert.equal(screen.getByRole("textbox", { name: "Follow-up prompt" }).getAttribute("placeholder"), "Start follow-up task");
      assert.equal(screen.getByRole("link", { name: "task_source" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/tasks/task_source");
      assert.equal(screen.getByRole("link", { name: "Follow-up task" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/tasks/task_successor");
    } finally {
      restoreClient(original);
    }
  });

  it("uses the projected API capability for owner, viewer, and active follow-up controls", async () => {
    const original = snapshotClient();
    const terminal = { ...dryRunTask, status: "completed" as const };
    apiClient.taskEvents = async () => []; apiClient.taskArtifacts = async () => []; apiClient.taskSummary = async () => ({ taskId: terminal.id, eventCount: 0, artifactCount: 0, updatedAt: terminal.updatedAt }); apiClient.taskFollowUps = async () => [];
    try {
      apiClient.task = async () => terminal; apiClient.projectCapabilities = async () => ({ canManageEndpoints: true, canManageMembers: true, canManagePolicy: true, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true });
      const owner = render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={terminal.id} />);
      await screen.findByRole("button", { name: "Start follow-up" }); owner.unmount();
      apiClient.projectCapabilities = async () => capabilities;
      const viewer = render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={terminal.id} />);
      await screen.findByRole("heading", { name: "Dry run" }); assert.equal(screen.queryByRole("button", { name: "Start follow-up" }), null); viewer.unmount();
      apiClient.task = async () => dryRunTask; apiClient.projectCapabilities = async () => taskCreatorCapabilities;
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={dryRunTask.id} />);
      await screen.findByRole("button", { name: "Send follow-up" });
    } finally { restoreClient(original); }
  });

  it("renders terminal and artifact recovery states from server task fields", async () => {
    const original = snapshotClient();
    const stopped = { ...dryRunTask, executionMode: "live" as const, status: "cancelled" as const, terminalReason: "cancelled" as const, artifactProjectionStatus: "failed" as const, artifactProjectionError: "Artifact tail is retrying", cleanupStatus: "failed" as const, cleanupError: "Sandbox cleanup will retry" };
    apiClient.task = async () => stopped;
    apiClient.taskEvents = async () => [];
    apiClient.taskArtifacts = async () => [];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.taskSummary = async () => ({ taskId: stopped.id, eventCount: 0, artifactCount: 0, updatedAt: stopped.updatedAt });
    apiClient.taskFollowUps = async () => [];
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={stopped.id} />);
      await screen.findByText("This task was cancelled and its app-owned sandbox resources are being reaped.");
      assert.equal(screen.getAllByText("failed", { selector: "dd" }).length, 2);
      assert.ok(screen.getByText("Artifact recovery: Artifact tail is retrying"));
      assert.ok(screen.getByText("Cleanup recovery: Sandbox cleanup will retry"));
    } finally { restoreClient(original); }
  });

  it("edits and deletes only pending follow-ups through idempotent client mutations", async () => {
    const original = snapshotClient();
    const originalUpdate = apiClient.updateTaskFollowUp;
    const originalDelete = apiClient.deleteTaskFollowUp;
    const terminal = { ...dryRunTask, status: "completed" as const };
    const keys: string[] = [];
    let editAttempts = 0;
    apiClient.task = async () => terminal;
    apiClient.taskEvents = async () => [];
    apiClient.taskArtifacts = async () => [];
    apiClient.projectCapabilities = async () => taskCreatorCapabilities;
    apiClient.taskSummary = async () => ({ taskId: terminal.id, eventCount: 0, artifactCount: 0, updatedAt: terminal.updatedAt });
    let followUps = [{ id: "follow_pending", taskId: terminal.id, prompt: "Original prompt", deliveryStatus: "pending" as const, createdAt: terminal.updatedAt }];
    apiClient.taskFollowUps = async () => followUps;
    apiClient.updateTaskFollowUp = async (_taskId, _followUpId, prompt, key) => { keys.push(key); editAttempts += 1; if (editAttempts === 1) throw new Error("Temporary edit failure"); return { id: "follow_pending", taskId: terminal.id, prompt, deliveryStatus: "pending", createdAt: terminal.updatedAt }; };
    apiClient.deleteTaskFollowUp = async (_taskId, followUpId, key) => { keys.push(key); followUps = []; return { deleted: true, followUpId }; };
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={terminal.id} />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit queued follow-up" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Updated prompt" } });
      fireEvent.click(screen.getByRole("button", { name: "Save follow-up" }));
      assert.ok(await screen.findByText("Temporary edit failure"));
      fireEvent.click(screen.getByRole("button", { name: "Save follow-up" }));
      await screen.findByText("Updated prompt");
      fireEvent.click(screen.getByRole("button", { name: "Delete queued follow-up" }));
      fireEvent.click(await screen.findByRole("button", { name: "Delete follow-up" }));
      await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Delete queued follow-up" }), null));
      assert.equal(keys.length, 3);
      assert.ok(keys.every((key) => key.startsWith("web-follow-up-")));
      assert.equal(keys[0], keys[1], "an explicit retry of the same request must reuse its idempotency key");
      assert.notEqual(keys[1], keys[2]);
    } finally { restoreClient(original); apiClient.updateTaskFollowUp = originalUpdate; apiClient.deleteTaskFollowUp = originalDelete; }
  });

  it("wraps the artifact header while preserving its title content", async () => {
    const original = snapshotClient();
    const completed = { ...dryRunTask, executionMode: "live" as const, status: "completed" as const };
    apiClient.task = async () => completed;
    apiClient.taskEvents = async () => [];
    apiClient.taskArtifacts = async () => [];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.taskSummary = async () => ({ taskId: completed.id, eventCount: 0, artifactCount: 0, updatedAt: completed.updatedAt });
    apiClient.taskFollowUps = async () => [];
    try {
      render(<TaskDetailPage workspaceId="workspace_1" projectId="project_1" taskId={completed.id} artifactsOnly />);
      const title = await screen.findByRole("heading", { name: "Published artifacts" });
      assert.match(title.parentElement?.className ?? "", /min-w-0/);
      assert.match(screen.getByRole("link", { name: "Task activity" }).parentElement?.className ?? "", /flex-wrap/);
    } finally {
      restoreClient(original);
    }
  });
});

function snapshotClient() { return { task: apiClient.task, taskEvents: apiClient.taskEvents, taskArtifacts: apiClient.taskArtifacts, projectCapabilities: apiClient.projectCapabilities, taskSummary: apiClient.taskSummary, taskFollowUps: apiClient.taskFollowUps }; }
function restoreClient(original: ReturnType<typeof snapshotClient>) { apiClient.task = original.task; apiClient.taskEvents = original.taskEvents; apiClient.taskArtifacts = original.taskArtifacts; apiClient.projectCapabilities = original.projectCapabilities; apiClient.taskSummary = original.taskSummary; apiClient.taskFollowUps = original.taskFollowUps; }

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, self: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
