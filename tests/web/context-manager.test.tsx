import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type ContextList } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { ContextManager } = await import("../../src/components/context/ContextManager.js");

afterEach(() => cleanup());

describe("context manager", () => {
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
    } finally { apiClient.contexts = original.contexts; apiClient.deleteContext = original.deleteContext; }
  });

  it("sends rename versions and offers recovery for a stale write", async () => {
    const original = { contexts: apiClient.contexts, saveContext: apiClient.saveContext };
    let loads = 0;
    apiClient.contexts = async (input) => { loads++; return { items: [{ id: "ctx_1", workspaceId: input.workspaceId, projectId: null, ownerUserId: "user_1", scope: input.scope, contextKey: "draft", content: "one", contentType: "text", version: 2, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }], canWrite: true } satisfies ContextList; };
    apiClient.saveContext = async () => { throw new ApiError(409, "Context changed elsewhere. Reload and try again."); };
    try {
      render(<ContextManager workspaceId="workspace_1" />);
      await screen.findByRole("textbox", { name: "Key" });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByRole("alert");
      fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
      await waitFor(() => assert.ok(loads >= 2));
    } finally { apiClient.contexts = original.contexts; apiClient.saveContext = original.saveContext; }
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
      fireEvent.change(content, { target: { value: "after" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, false));
      assert.equal((screen.getByRole("textbox", { name: "Content" }) as HTMLTextAreaElement).value, "after");
      assert.equal(reads, 1);
      assert.equal(screen.queryByRole("button", { name: "Try again" }), null);
      assert.equal(screen.queryByText("Context list unavailable."), null);
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
