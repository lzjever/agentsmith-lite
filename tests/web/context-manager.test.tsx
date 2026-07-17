import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type ContextList } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { ContextManager } = await import("../../src/components/context/ContextManager.js");

afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

describe("context manager", () => {
  it("opens a valid personal scope deep link and ignores unknown scopes", async () => {
    const original = { contexts: apiClient.contexts };
    const calls: string[] = [];
    apiClient.contexts = async (input) => {
      calls.push(input.scope);
      return { items: [], canWrite: true };
    };
    try {
      window.history.replaceState({}, "", "/?scope=workspace_personal");
      const view = render(<ContextManager workspaceId="workspace_1" />);
      await waitFor(() => assert.deepEqual(calls, ["workspace_personal"]));
      assert.equal(screen.getByRole("tab", { name: "My workspace" }).getAttribute("data-state"), "active");

      view.unmount();
      calls.length = 0;
      window.history.replaceState({}, "", "/?scope=project_personal");
      render(<ContextManager workspaceId="workspace_1" />);
      await waitFor(() => assert.deepEqual(calls, ["workspace_shared"]));
      assert.equal(new URL(window.location.href).searchParams.has("scope"), false);
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps the newest context scope response", async () => {
    const original = { contexts: apiClient.contexts };
    let resolveShared!: (value: ContextList) => void;
    const entry = (scope: "workspace_shared" | "workspace_personal", contextKey: string): ContextList => ({ items: [{ id: contextKey, workspaceId: "workspace_1", projectId: null, ownerUserId: scope === "workspace_personal" ? "user_1" : null, scope, contextKey, content: contextKey, contentType: "text", version: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }], canWrite: true });
    apiClient.contexts = async (input) => input.scope === "workspace_shared" ? new Promise((resolve) => { resolveShared = resolve; }) : entry("workspace_personal", "personal.current");
    try {
      render(<ContextManager workspaceId="workspace_1" />);
      await waitFor(() => assert.ok(resolveShared));
      fireEvent.click(screen.getByRole("tab", { name: "My workspace" }));
      await waitFor(() => assert.equal((screen.getByRole("textbox", { name: "Key" }) as HTMLInputElement).value, "personal.current"));
      await act(async () => { resolveShared(entry("workspace_shared", "shared.stale")); await Promise.resolve(); });
      assert.equal((screen.getByRole("textbox", { name: "Key" }) as HTMLInputElement).value, "personal.current");
      assert.equal(screen.queryByText("shared.stale"), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("loads scopes, keeps read-only entries non-editable, and saves through the API", async () => {
    const original = { contexts: apiClient.contexts, saveContext: apiClient.saveContext, deleteContext: apiClient.deleteContext };
    const calls: Array<Record<string, unknown>> = [];
    apiClient.contexts = async (input) => ({ items: [{ id: "ctx_1", workspaceId: input.workspaceId, projectId: input.projectId ?? null, ownerUserId: null, scope: input.scope, contextKey: "shared.rules", content: "Use brief replies.", contentType: "markdown", version: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }], canWrite: input.scope !== "workspace_shared" } satisfies ContextList);
    apiClient.saveContext = async (input) => { calls.push(input); return { id: "ctx_2", workspaceId: input.workspaceId, projectId: input.projectId ?? null, ownerUserId: null, ...input, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }; };
    try {
      render(<ContextManager workspaceId="workspace_1" projectId="project_1" />);
      await screen.findByText("Your access to this context is read-only.");
      await waitFor(() => assert.equal((screen.getByRole("textbox", { name: "Key" }) as HTMLInputElement).value, "shared.rules"));
      assert.equal((screen.getByRole("textbox", { name: "Content" }) as HTMLTextAreaElement).value, "Use brief replies.");
      assert.equal((screen.getByRole("textbox", { name: "Key" }) as HTMLInputElement).disabled, true);
      fireEvent.click(screen.getByRole("tab", { name: "My workspace" }));
      const key = await screen.findByRole("textbox", { name: "Key" });
      await waitFor(() => assert.equal((key as HTMLInputElement).disabled, false));
      await waitFor(() => assert.equal((key as HTMLInputElement).value, "shared.rules"));
      fireEvent.change(key, { target: { value: "my.rules" } });
      fireEvent.change(screen.getByRole("textbox", { name: "Content" }), { target: { value: "private" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => assert.equal(calls.length, 1));
      assert.deepEqual(calls[0], { workspaceId: "workspace_1", scope: "workspace_personal", contextKey: "my.rules", previousContextKey: "shared.rules", expectedVersion: 1, content: "private", contentType: "markdown" });
      fireEvent.click(screen.getByRole("tab", { name: "Project shared" }));
      await waitFor(() => assert.ok(screen.getByText("Available to members of this project.")));
    } finally { apiClient.contexts = original.contexts; apiClient.saveContext = original.saveContext; apiClient.deleteContext = original.deleteContext; }
  });

  it("reuses a context save key after an unknown network result", async () => {
    const original = { contexts: apiClient.contexts, saveContext: apiClient.saveContext };
    const keys: string[] = [];
    apiClient.contexts = async () => ({ items: [], canWrite: true });
    apiClient.saveContext = (async (input: Parameters<typeof apiClient.saveContext>[0], key: string) => {
      keys.push(key);
      if (keys.length === 1) throw new Error("connection closed");
      return { id: "ctx_retry", workspaceId: input.workspaceId, projectId: input.projectId ?? null, ownerUserId: "user_1", ...input, version: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" };
    }) as typeof apiClient.saveContext;
    try {
      render(<ContextManager workspaceId="workspace_1" />);
      fireEvent.change(await screen.findByRole("textbox", { name: "Key" }), { target: { value: "my.notes" } });
      fireEvent.change(screen.getByRole("textbox", { name: "Content" }), { target: { value: "Keep this draft" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => assert.equal(keys.length, 1));
      assert.match(screen.getByRole("alert").textContent ?? "", /Context could not be saved/);
      assert.equal((screen.getByRole("textbox", { name: "Content" }) as HTMLTextAreaElement).value, "Keep this draft");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => assert.equal(keys.length, 2));
      assert.equal(keys[1], keys[0]);
    } finally { Object.assign(apiClient, original); }
  });

  it("confirms a writable context deletion before calling the API", async () => {
    const original = { contexts: apiClient.contexts, deleteContext: apiClient.deleteContext };
    const deleted: Array<Record<string, unknown>> = [];
    apiClient.contexts = async (input) => ({ items: [{ id: "ctx_1", workspaceId: input.workspaceId, projectId: input.projectId ?? null, ownerUserId: null, scope: input.scope, contextKey: "mine", content: "private", contentType: "text", version: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }], canWrite: input.scope === "workspace_personal" } satisfies ContextList);
    apiClient.deleteContext = async (input) => { deleted.push(input); return { deleted: true }; };
    try {
      render(<ContextManager workspaceId="workspace_1" />);
      fireEvent.click(await screen.findByRole("tab", { name: "My workspace" }));
      fireEvent.click(await screen.findByText("mine"));
      await screen.findByRole("button", { name: "Delete" });
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await screen.findByRole("alertdialog", { name: "Delete context entry" });
      assert.equal(deleted.length, 0);
      fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
      await waitFor(() => assert.equal(deleted.length, 1));
      assert.deepEqual(deleted[0], { workspaceId: "workspace_1", scope: "workspace_personal", contextKey: "mine", expectedVersion: 1 });
    } finally { apiClient.contexts = original.contexts; apiClient.deleteContext = original.deleteContext; }
  });

  it("keeps delete confirmation open when context deletion fails", async () => {
    const original = { contexts: apiClient.contexts, deleteContext: apiClient.deleteContext };
    const entry = { id: "ctx_delete", workspaceId: "workspace_1", projectId: null, ownerUserId: "user_1", scope: "workspace_shared" as const, contextKey: "project.rules", content: "keep", contentType: "text" as const, version: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" };
    apiClient.contexts = async () => ({ items: [entry], canWrite: true });
    apiClient.deleteContext = async () => { throw new ApiError(409, "Context is still in use."); };
    try {
      render(<ContextManager workspaceId="workspace_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
      const dialog = await screen.findByRole("alertdialog", { name: "Delete context entry" });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete entry" })); await Promise.resolve(); });
      assert.ok(screen.getByRole("alertdialog", { name: "Delete context entry" }));
      assert.ok(screen.getByText("project.rules"));
      assert.equal(dialog.isConnected, true);
    } finally { Object.assign(apiClient, original); }
  });

  it("sends rename versions and offers recovery for a stale write", async () => {
    const original = { contexts: apiClient.contexts, saveContext: apiClient.saveContext };
    let loads = 0;
    apiClient.contexts = async (input) => { loads++; return { items: [{ id: "ctx_1", workspaceId: input.workspaceId, projectId: null, ownerUserId: "user_1", scope: input.scope, contextKey: "draft", content: "one", contentType: "text", version: 2, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }], canWrite: true } satisfies ContextList; };
    apiClient.saveContext = async () => { throw new ApiError(409, "Context changed elsewhere. Reload and try again."); };
    try {
      render(<ContextManager workspaceId="workspace_1" />);
      fireEvent.change(await screen.findByRole("textbox", { name: "Content" }), { target: { value: "two" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByRole("alert");
      fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
      await waitFor(() => assert.ok(loads >= 2));
    } finally { apiClient.contexts = original.contexts; apiClient.saveContext = original.saveContext; }
  });

  it("fails closed when context write permission is revoked", async () => {
    const original = { contexts: apiClient.contexts, saveContext: apiClient.saveContext };
    const entry = { id: "ctx_denied", workspaceId: "workspace_1", projectId: null, ownerUserId: "user_1", scope: "workspace_shared" as const, contextKey: "project.rules", content: "before", contentType: "text" as const, version: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" };
    apiClient.contexts = async () => ({ items: [entry], canWrite: true });
    apiClient.saveContext = async () => { throw new ApiError(403, "Forbidden"); };
    try {
      render(<ContextManager workspaceId="workspace_1" />);
      fireEvent.change(await screen.findByRole("textbox", { name: "Content" }), { target: { value: "after" } });
      fireEvent.click(await screen.findByRole("button", { name: "Save" }));
      await screen.findByText("Context write permission changed. This scope is now read-only.");
      assert.equal(screen.queryByRole("button", { name: "Save" }), null);
      assert.equal(screen.queryByRole("button", { name: "Delete" }), null);
      assert.equal((screen.getByRole("textbox", { name: "Content" }) as HTMLTextAreaElement).disabled, true);
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps a successful context save when a later list read would fail", async () => {
    const original = { contexts: apiClient.contexts, saveContext: apiClient.saveContext };
    const entry = { id: "ctx_1", workspaceId: "workspace_1", projectId: null, ownerUserId: "user_1", scope: "workspace_shared" as const, contextKey: "project.rules", content: "before", contentType: "text" as const, version: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" };
    let reads = 0;
    apiClient.contexts = async () => { reads += 1; if (reads > 1) throw new ApiError(503, "Context list unavailable."); return { items: [entry], canWrite: true }; };
    apiClient.saveContext = async () => ({ ...entry, content: "after", version: 2, updatedAt: "2026-07-11T00:01:00.000Z" });
    try {
      render(<ContextManager workspaceId="workspace_1" />);
      const content = await screen.findByRole("textbox", { name: "Content" });
      const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
      assert.equal(save.disabled, true);
      fireEvent.change(content, { target: { value: "after" } });
      await waitFor(() => assert.equal(save.disabled, false));
      fireEvent.click(save);
      await waitFor(() => assert.equal(save.disabled, true));
      assert.equal((screen.getByRole("textbox", { name: "Content" }) as HTMLTextAreaElement).value, "after");
      assert.equal(reads, 1);
      assert.equal(screen.queryByRole("button", { name: "Try again" }), null);
      assert.equal(screen.queryByText("Context list unavailable."), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("ignores key padding and keeps entry navigation locked while saving", async () => {
    const original = { contexts: apiClient.contexts, saveContext: apiClient.saveContext };
    const makeEntry = (id: string, content: string) => ({ id, workspaceId: "workspace_1", projectId: null, ownerUserId: "user_1", scope: "workspace_personal" as const, contextKey: id, content, contentType: "text" as const, version: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" });
    let finishSave: ((value: ReturnType<typeof makeEntry>) => void) | undefined;
    apiClient.contexts = async () => ({ items: [makeEntry("first", "First"), makeEntry("second", "Second")], canWrite: true });
    apiClient.saveContext = async () => new Promise((resolve) => { finishSave = resolve; });
    try {
      render(<ContextManager workspaceId="workspace_1" />);
      const key = await screen.findByRole("textbox", { name: "Key" }) as HTMLInputElement;
      const content = screen.getByRole("textbox", { name: "Content" }) as HTMLTextAreaElement;
      const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
      fireEvent.change(key, { target: { value: "  first  " } });
      assert.equal(save.disabled, true);

      fireEvent.change(content, { target: { value: "Changed" } });
      fireEvent.click(save);
      await waitFor(() => assert.ok(finishSave));
      assert.equal((screen.getByRole("button", { name: "second text" }) as HTMLButtonElement).disabled, true);
      assert.equal((screen.getByRole("button", { name: "New context entry" }) as HTMLButtonElement).disabled, true);

      await act(async () => finishSave!({ ...makeEntry("first", "Changed"), version: 2 }));
    } finally { Object.assign(apiClient, original); }
  });

  it("does not apply a completed save after switching workspaces", async () => {
    const original = { contexts: apiClient.contexts, saveContext: apiClient.saveContext };
    const entry = (workspaceId: string, content: string) => ({ id: `ctx_${workspaceId}`, workspaceId, projectId: null, ownerUserId: null, scope: "workspace_shared" as const, contextKey: "shared.rules", content, contentType: "text" as const, version: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" });
    let finishSave: ((value: ReturnType<typeof entry>) => void) | undefined;
    apiClient.contexts = async (input) => ({ items: [entry(input.workspaceId, input.workspaceId === "workspace_1" ? "Workspace A" : "Workspace B")], canWrite: true });
    apiClient.saveContext = async () => new Promise((resolve) => { finishSave = resolve; });
    try {
      const view = render(<ContextManager workspaceId="workspace_1" />);
      const content = await screen.findByRole("textbox", { name: "Content" }) as HTMLTextAreaElement;
      fireEvent.change(content, { target: { value: "Changed A" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => assert.ok(finishSave));

      view.rerender(<ContextManager workspaceId="workspace_2" />);
      await waitFor(() => assert.equal((screen.getByRole("textbox", { name: "Content" }) as HTMLTextAreaElement).value, "Workspace B"));
      await act(async () => finishSave!(entry("workspace_1", "Changed A")));
      assert.equal((screen.getByRole("textbox", { name: "Content" }) as HTMLTextAreaElement).value, "Workspace B");
    } finally { Object.assign(apiClient, original); }
  });

  it("protects unsaved edits before changing entries or scopes", async () => {
    const original = { contexts: apiClient.contexts };
    const makeEntry = (id: string, scope: "workspace_shared" | "workspace_personal", content: string) => ({ id, workspaceId: "workspace_1", projectId: null, ownerUserId: null, scope, contextKey: id, content, contentType: "text" as const, version: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" });
    apiClient.contexts = async (input) => ({ items: input.scope === "workspace_shared" ? [makeEntry("first", "workspace_shared", "First"), makeEntry("second", "workspace_shared", "Second")] : [makeEntry("personal", "workspace_personal", "Personal")], canWrite: true });
    try {
      render(<ContextManager workspaceId="workspace_1" />);
      const content = await screen.findByRole("textbox", { name: "Content" }) as HTMLTextAreaElement;
      fireEvent.change(content, { target: { value: "Unsaved" } });
      fireEvent.click(screen.getByRole("button", { name: "second text" }));
      await screen.findByRole("alertdialog", { name: "Discard unsaved context changes?" });
      assert.equal(content.value, "Unsaved");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      assert.equal(content.value, "Unsaved");

      fireEvent.click(screen.getByRole("button", { name: "second text" }));
      fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
      await waitFor(() => assert.equal(content.value, "Second"));
      fireEvent.change(content, { target: { value: "Another unsaved edit" } });
      fireEvent.click(screen.getByRole("tab", { name: "My workspace" }));
      fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
      await waitFor(() => assert.equal((screen.getByRole("textbox", { name: "Content" }) as HTMLTextAreaElement).value, "Personal"));
    } finally { Object.assign(apiClient, original); }
  });
});

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, self: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(globalThis, { requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number, cancelAnimationFrame: (id: number) => clearTimeout(id) });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
