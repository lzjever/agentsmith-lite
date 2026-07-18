import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { after, afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type Endpoint, type ProjectFile, type Task } from "../../src/lib/api/client.js";

const dom = installDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { TaskCreateDialog } = await import("../../src/components/tasks/TaskCreateDialog.js");
const { TaskList } = await import("../../src/components/tasks/TaskList.js");

afterEach(() => cleanup());
after(() => {
  cleanup();
  dom.window.close();
});

describe("task list controls", () => {
  it("sends search and cursor actions to the server-owned list controller", () => {
    const tasks = [task(9, "Release checklist"), task(10, "Task 10")];
    const queries: unknown[] = [];
    let next = 0;
    render(<TaskList page={{ items: tasks, total: 10, nextCursor: "cursor-2" }} basePath="/workspaces/ws/projects/project/tasks" query={{ archived: "exclude", sort: "updated_at", direction: "desc", limit: 25 }} pageIndex={0} onQueryChange={(query) => queries.push(query)} onNext={() => { next += 1; }} onPrevious={() => undefined} />);

    assert.equal(screen.getByRole("link", { name: /Release checklist/ }).getAttribute("href"), "/workspaces/ws/projects/project/tasks/task_9");
    fireEvent.change(screen.getByRole("textbox", { name: "Search tasks" }), { target: { value: "release" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply task search" }));
    assert.deepEqual(queries[0], { archived: "exclude", sort: "updated_at", direction: "desc", limit: 25, search: "release", cursor: undefined });
    assert.ok(screen.getByText("Release checklist"), "the component must not apply a second browser-side filter");
    fireEvent.click(screen.getByRole("button", { name: "Next task page" }));
    assert.equal(next, 1);
  });

  it("keeps a create failure in the dialog so the prompt can be corrected", async () => {
    const endpoint: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: "x", updatedAt: "x" };
    let attempts = 0;
    let submitted: { inputPaths: string[] } | undefined;
    render(<TaskCreateDialog endpoints={[endpoint]} projectFiles={[{ name: "brief.md", path: "files/brief.md", type: "file", size: 12, mediaType: "text/markdown", updatedAt: "x" }]} projectFilesLoading={false} open saving={false} onClose={() => undefined} onCreate={async (input) => { attempts += 1; submitted = input; throw new Error("Endpoint is unavailable"); }} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "Generate notes" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /brief.md/ }));
    fireEvent.submit(screen.getByRole("form", { name: "Create task" }));

    const alert = await screen.findByRole("alert");
    assert.match(alert.textContent ?? "", /Endpoint is unavailable/);
    assert.equal(attempts, 1);
    assert.deepEqual(submitted?.inputPaths, ["files/brief.md"]);
    assert.equal((screen.getByRole("textbox", { name: "Task prompt" }) as HTMLTextAreaElement).value, "Generate notes");
  });

  it("preserves the task draft when project files finish loading", async () => {
    const endpoint: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: "x", updatedAt: "x" };
    const dialog = <TaskCreateDialog endpoints={[endpoint]} projectFiles={[]} projectFilesLoading open saving={false} onClose={() => undefined} onCreate={async () => undefined} />;
    const view = render(dialog);

    fireEvent.change(screen.getByRole("textbox", { name: "Task prompt" }), { target: { value: "Keep this draft" } });
    view.rerender(<TaskCreateDialog endpoints={[endpoint]} projectFiles={[{ name: "brief.md", path: "files/brief.md", type: "file", size: 12, mediaType: "text/markdown", updatedAt: "x" }]} projectFilesLoading={false} open saving={false} onClose={() => undefined} onCreate={async () => undefined} />);

    assert.equal((screen.getByRole("textbox", { name: "Task prompt" }) as HTMLTextAreaElement).value, "Keep this draft");
    assert.ok(screen.getByRole("checkbox", { name: "Attach brief.md" }));
  });

  it("locks task input navigation and selection while creation is busy", async () => {
    const endpoint: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: "x", updatedAt: "x" };
    const files: ProjectFile[] = [
      { name: "reports", path: "files/reports", type: "directory", updatedAt: "x" },
      { name: "brief.md", path: "files/brief.md", type: "file", size: 12, mediaType: "text/markdown", updatedAt: "x" },
    ];
    const props = { projectId: "project_1", endpoints: [endpoint], projectFiles: files, projectFilesLoading: false, open: true, onClose: () => undefined, onCreate: async () => undefined };
    const view = render(<TaskCreateDialog {...props} saving={false} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Attach brief.md" }));

    view.rerender(<TaskCreateDialog {...props} saving />);

    for (const button of [screen.getByRole("button", { name: "files" }), screen.getByRole("button", { name: "reports" }), screen.getByTitle("Remove files/brief.md")]) {
      assert.equal((button as HTMLButtonElement).disabled, true);
    }
    assert.equal((screen.getByRole("checkbox", { name: "Attach brief.md" }) as HTMLInputElement).disabled, true);
  });

  it("exposes one named upload action in the task dialog", () => {
    const endpoint: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: "x", updatedAt: "x" };
    render(<TaskCreateDialog projectId="project_1" canWriteFiles endpoints={[endpoint]} projectFiles={[]} projectFilesLoading={false} open saving={false} onClose={() => undefined} onCreate={async () => undefined} />);

    assert.equal(screen.getAllByRole("button", { name: "Upload and attach" }).length, 1);
    assert.equal((document.querySelector('input[type="file"]') as HTMLInputElement).hidden, true);
  });

  it("guides task input quota failures to the resource policy", async () => {
    const original = apiClient.uploadFile;
    const endpoint: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: "x", updatedAt: "x" };
    apiClient.uploadFile = async () => { throw new ApiError(409, "Project file bytes limit reached", "project_file_bytes_limit_reached"); };
    try {
      render(<TaskCreateDialog projectId="project_1" policyHref="/projects/project_1/policy" canWriteFiles endpoints={[endpoint]} projectFiles={[]} projectFilesLoading={false} open saving={false} onClose={() => undefined} onCreate={async () => undefined} />);
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "brief.txt")] } });
      await screen.findByText("File storage limit reached.");
      assert.equal(screen.getByRole("link", { name: "Open resource policy" }).getAttribute("href"), "/projects/project_1/policy");
    } finally { apiClient.uploadFile = original; }
  });

  it("reuses a pending key when a task input upload is retried", async () => {
    const original = { uploadFile: apiClient.uploadFile, files: apiClient.files };
    const endpoint: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: "x", updatedAt: "x" };
    const uploadKeys: Array<string | undefined> = [];
    let uploadAttempts = 0;
    apiClient.files = async () => ({ entries: [] });
    apiClient.uploadFile = async (_projectId, path, _file, options) => { uploadKeys.push(options?.idempotencyKey); if (++uploadAttempts === 1) throw new Error("connection closed"); return { path, bytes: 1, mediaType: "text/plain", updatedAt: "x" }; };
    try {
      render(<TaskCreateDialog projectId="project_1" canWriteFiles endpoints={[endpoint]} projectFiles={[]} projectFilesLoading={false} open saving={false} onClose={() => undefined} onCreate={async () => undefined} />);
      const file = new File(["a"], "brief.txt", { type: "text/plain", lastModified: 1 });
      const input = document.querySelector('input[type="file"]')!;
      fireEvent.change(input, { target: { files: [file] } });
      await screen.findByText("connection closed");
      fireEvent.change(input, { target: { files: [file] } });
      await waitFor(() => assert.equal(uploadAttempts, 2));
      assert.ok(uploadKeys[0]);assert.equal(uploadKeys[1],uploadKeys[0]);
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps task input browsing on the latest selected folder", async () => {
    const originalFiles = apiClient.files;
    const endpoint: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: "x", updatedAt: "x" };
    const folder = { name: "reports", path: "files/reports", type: "directory" as const, updatedAt: "x" };
    let resolveFolder!: (value: { entries: ProjectFile[] }) => void;
    const pendingFolder = new Promise<{ entries: ProjectFile[] }>((resolve) => { resolveFolder = resolve; });
    apiClient.files = async (_projectId, path) => path === folder.path ? pendingFolder : { entries: [{ name: "brief.md", path: "files/brief.md", type: "file", size: 12, mediaType: "text/markdown", updatedAt: "x" }] };
    try {
      render(<TaskCreateDialog projectId="project_1" endpoints={[endpoint]} projectFiles={[folder]} projectFilesLoading={false} open saving={false} onClose={() => undefined} onCreate={async () => undefined} />);
      fireEvent.click(screen.getByRole("button", { name: "reports" }));
      fireEvent.click(await screen.findByRole("button", { name: "files" }));
      await screen.findByRole("checkbox", { name: "Attach brief.md" });
      await act(async () => { resolveFolder({ entries: [{ name: "stale.txt", path: "files/reports/stale.txt", type: "file", updatedAt: "x" }] }); });
      assert.ok(screen.getByRole("checkbox", { name: "Attach brief.md" }));
      assert.equal(screen.queryByRole("checkbox", { name: "Attach stale.txt" }), null);
    } finally {
      apiClient.files = originalFiles;
    }
  });

  it("resets a pending task input navigation when the dialog is reopened", async () => {
    const originalFiles = apiClient.files;
    const endpoint: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "Endpoint", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "model", credentialId: "credential_1", capabilities: ["text", "tool_calls"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: "x", updatedAt: "x" };
    const folder = { name: "reports", path: "files/reports", type: "directory" as const, updatedAt: "x" };
    let resolveFolder!: (value: { entries: ProjectFile[] }) => void;
    apiClient.files = async () => new Promise<{ entries: ProjectFile[] }>((resolve) => { resolveFolder = resolve; });
    const props = { projectId: "project_1", endpoints: [endpoint], projectFiles: [folder], projectFilesLoading: false, saving: false, onClose: () => undefined, onCreate: async () => undefined };
    try {
      const view = render(<TaskCreateDialog {...props} open />);
      fireEvent.click(screen.getByRole("button", { name: "reports" }));
      await screen.findByText("Loading project files...");
      view.rerender(<TaskCreateDialog {...props} open={false} />);
      view.rerender(<TaskCreateDialog {...props} open />);
      assert.ok(await screen.findByRole("button", { name: "reports" }));
      assert.equal(screen.queryByText("Loading project files..."), null);
      await act(async () => { resolveFolder({ entries: [] }); });
    } finally {
      apiClient.files = originalFiles;
    }
  });
});

function task(index: number, prompt: string): Task {
  return {
    id: `task_${index}`,
    workspaceId: "ws",
    projectId: "project",
    endpointId: "endpoint",
    prompt,
    status: "completed",
    runId: `run_${index}`,
    executionMode: "live",
    sandbox: { namespace: "agentsmith" },
    createdAt: `2026-07-12T00:${String(index).padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-07-12T00:${String(index).padStart(2, "0")}:00.000Z`
  };
}

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLFormElement: dom.window.HTMLFormElement, Element: dom.window.Element, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, self: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(globalThis, { PointerEvent: dom.window.PointerEvent });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  return dom;
}
