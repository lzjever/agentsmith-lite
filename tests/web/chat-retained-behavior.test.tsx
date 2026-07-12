import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { apiClient, type Endpoint, type ProjectCapabilities, type ProjectChatThread } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { ChatMessageList } = await import("../../src/components/chat/ChatMessageList.js");
const { ChatThreadRail } = await import("../../src/components/chat/ChatThreadRail.js");
const { ProjectOverviewPage } = await import("../../src/components/projects/ProjectOverviewPage.js");
const { ProjectChatPage } = await import("../../src/components/chat/ProjectChatPage.js");

afterEach(() => cleanup());

const endpoint: Endpoint = { id: "endpoint_1", projectId: "project_1", name: "DeepSeek chat", protocol: "openai_chat_completions", baseUrl: "https://example.test/v1", model: "deepseek-chat", credentialId: "credential_1", capabilities: ["text"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: false, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" };
const threads: ProjectChatThread[] = [{ id: "chat_1", projectId: "project_1", endpointId: endpoint.id, title: "Product Q&A", createdAt: endpoint.createdAt, updatedAt: endpoint.updatedAt }];
const readOnly: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: false, canCreateTasks: false, canCancelTasks: false, canSendChat: false };

describe("retained chat and overview behavior", () => {
  it("renders GFM and fenced code without rendering raw HTML, and copies the original message", async () => {
    const writes: string[] = [];
    Object.assign(navigator, { clipboard: { writeText: async (value: string) => { writes.push(value); } } });
    render(<ChatMessageList empty={false} sending={false} messages={[{ role: "assistant", content: "# Heading\n\n- item\n\n```ts\nconst ok = true;\n```\n\n<script>bad()</script>" }]} />);
    assert.ok(screen.getByRole("heading", { name: "Heading" }));
    assert.ok(screen.getByText("item"));
    assert.ok(screen.getByText("const ok = true;"));
    assert.equal(screen.queryByText("bad()"), null);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => assert.equal(writes.length, 1));
    assert.match(writes[0]!, /const ok = true/);
  });

  it("searches titles and confirms rename and deletion with dialogs", async () => {
    const renamed: Array<[string, string]> = [];
    const deleted: string[] = [];
    const pinned:string[]=[];const starred:string[]=[];
    render(<ChatThreadRail threads={threads} endpoints={[endpoint]} selectedThreadId="" disabled={false} onNewThread={() => undefined} onSelect={() => undefined} onRename={(id, title) => renamed.push([id, title])} onPin={(id)=>pinned.push(id)} onStar={(id)=>starred.push(id)} onDelete={(id) => deleted.push(id)} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search conversations" }), { target: { value: "missing" } });
    assert.ok(screen.getByText("No conversations match this search."));
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search conversations" }), { target: { value: "Product" } });
    assert.ok(screen.getByText("Product Q&A"));
    fireEvent.click(screen.getByRole("button",{name:"Star conversation"}));fireEvent.click(screen.getByRole("button",{name:"Pin conversation"}));assert.deepEqual(starred,["chat_1"]);assert.deepEqual(pinned,["chat_1"]);
    fireEvent.click(screen.getByRole("button", { name: "Rename conversation" }));
    await screen.findByRole("dialog", { name: "Rename conversation" });
    fireEvent.change(screen.getByRole("textbox", { name: "Conversation title" }), { target: { value: "Architecture review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    assert.deepEqual(renamed, [["chat_1", "Architecture review"]]);
    fireEvent.click(screen.getByRole("button", { name: "Delete conversation" }));
    await screen.findByRole("alertdialog", { name: "Delete conversation" });
    fireEvent.click(screen.getAllByRole("button", { name: "Delete conversation" }).at(-1)!);
    await waitFor(() => assert.deepEqual(deleted, ["chat_1"]));
    cleanup();
    render(<ChatThreadRail loading threads={[]} endpoints={[]} selectedThreadId="" disabled={false} onNewThread={() => undefined} onSelect={() => undefined} onRename={() => undefined} onPin={() => undefined} onStar={() => undefined} onDelete={() => undefined} />);
    assert.ok(screen.getByText("Loading conversations..."));
  });

  it("renders versioned message edit, delete, branch, and failed retry actions",async()=>{
    const message={id:"message_1",threadId:"chat_1",sequence:1,version:2,deliveryStatus:"failed" as const,role:"user" as const,content:"Original",createdAt:endpoint.createdAt,updatedAt:endpoint.updatedAt};const completed={...message,id:"message_2",sequence:2,version:1,deliveryStatus:"completed" as const,role:"assistant" as const,content:"Completed"};const edits:Array<[string,string]>=[];const deleted:string[]=[];const branched:string[]=[];const retried:string[]=[];
    render(<ChatMessageList empty={false} sending={false} messages={[message,completed]} onEdit={(item,content)=>edits.push([item.id,content])} onDelete={(item)=>deleted.push(item.id)} onBranch={(item)=>branched.push(item.id)} onRetry={(item)=>retried.push(item.id)}/>);assert.ok(screen.getByText("Provider request failed."));fireEvent.click(screen.getByRole("button",{name:"Retry"}));assert.deepEqual(retried,["message_1"]);fireEvent.click(screen.getByRole("button",{name:"Branch from message"}));assert.deepEqual(branched,["message_2"]);fireEvent.click(screen.getByRole("button",{name:"Edit message"}));await screen.findByRole("dialog",{name:"Edit message"});fireEvent.change(screen.getByRole("textbox",{name:"Message text"}),{target:{value:"Revised"}});fireEvent.click(screen.getByRole("button",{name:"Save message"}));assert.deepEqual(edits,[["message_1","Revised"]]);fireEvent.click(screen.getAllByRole("button",{name:"Delete message"})[0]!);const dialog=await screen.findByRole("alertdialog",{name:"Delete message"});fireEvent.click(within(dialog).getByRole("button",{name:"Delete message"}));await waitFor(()=>assert.deepEqual(deleted,["message_1"]));
  });

  it("uses projected capabilities to hide management entry points and state read-only access", async () => {
    const original = { projectCapabilities: apiClient.projectCapabilities, members: apiClient.members, currentIdentity: apiClient.currentIdentity };
    apiClient.projectCapabilities = async () => readOnly;
    apiClient.members = async () => [{ projectId: "project_1", userId: "owner_1", role: "owner", displayName: "Project Owner", email: "owner@example.test", createdAt: endpoint.createdAt, updatedAt: endpoint.updatedAt }, { projectId: "project_1", userId: "viewer_1", role: "viewer", displayName: "Viewer", email: "viewer@example.test", createdAt: endpoint.createdAt, updatedAt: endpoint.updatedAt }];
    apiClient.currentIdentity = async () => ({ user: { id: "viewer_1", email: "viewer@example.test" } });
    try {
      render(<ProjectOverviewPage workspaceId="workspace_1" projectId="project_1" />);
      await screen.findByText("This project is available for viewing.");
      assert.ok(screen.getByText("Owner: Project Owner · Your access: Viewer · Status: Active"));
      assert.equal(screen.queryByRole("link", { name: "Configure an endpoint" }), null);
      assert.equal(screen.queryByRole("link", { name: "Invite collaborators" }), null);
      assert.ok(screen.getByText("Execution"));
      assert.ok(screen.getByText("Develop"));
      assert.ok(screen.getByText("Manage"));
      assert.ok(screen.getByRole("link", { name: "Endpoints" }));
      assert.ok(screen.getByRole("link", { name: "Members" }));
      assert.ok(screen.getByRole("link", { name: "Resource policy" }));
      assert.ok(screen.getByRole("link", { name: "Tasks" }));
    } finally {
      apiClient.projectCapabilities = original.projectCapabilities;
      apiClient.members = original.members;
      apiClient.currentIdentity = original.currentIdentity;
    }
  });

  it("keeps the persisted user message after stopping an active stream", async () => {
    const original = { endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities, chatThreads: apiClient.chatThreads, chatMessages: apiClient.chatMessages, sendChatMessage: apiClient.sendChatMessage };
    let aborted = false;
    apiClient.endpoints = async () => [endpoint];
    apiClient.projectCapabilities = async () => ({ ...readOnly, canSendChat: true });
    const secondThread={...threads[0]!,id:"chat_2",title:"Second conversation"};apiClient.chatThreads = async () => [...threads,secondThread];
    let historyReads = 0;
    apiClient.chatMessages = async () => historyReads++ === 0 ? [] : [{ id: "message_1", threadId: "chat_1", role: "user", content: "hello", createdAt: endpoint.createdAt }];
    apiClient.sendChatMessage = async (_projectId, _threadId, _content, _afterMessageId, signal, onDelta) => {
      onDelta("partial answer");
      await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); }, { once: true }));
      throw new Error("unreachable");
    };
    try {
      render(<ProjectChatPage projectId="project_1" />);
      const message = await screen.findByRole("textbox", { name: "Message" });
      fireEvent.change(message, { target: { value: "hello" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await screen.findByText("partial answer");
      fireEvent.click(screen.getByRole("button",{name:"Second conversation"}));
      assert.equal(screen.getByRole("button",{name:"Product Q&A"}).getAttribute("aria-current"),"true");
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await waitFor(() => assert.equal(aborted, true));
      await screen.findAllByText("hello");
      assert.ok(historyReads >= 2);
      await waitFor(() => assert.equal((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value, ""));
    } finally {
      apiClient.endpoints = original.endpoints;
      apiClient.projectCapabilities = original.projectCapabilities;
      apiClient.chatThreads = original.chatThreads;
      apiClient.chatMessages = original.chatMessages;
      apiClient.sendChatMessage = original.sendChatMessage;
    }
  });

  it("clears the previous thread immediately while the selected thread loads", async () => {
    const original = { endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities, chatThreads: apiClient.chatThreads, chatMessages: apiClient.chatMessages };
    let resolveSecond: ((messages: any[]) => void) | undefined;
    apiClient.endpoints = async () => [endpoint];
    apiClient.projectCapabilities = async () => ({ ...readOnly, canSendChat: true });
    apiClient.chatThreads = async () => [...threads, { ...threads[0]!, id: "chat_2", title: "Release notes" }];
    apiClient.chatMessages = async (_projectId, threadId) => {
      if (threadId === "chat_1") return [{ id: "message_1", threadId, role: "assistant", content: "First conversation", createdAt: endpoint.createdAt }];
      return new Promise((resolve) => { resolveSecond = resolve; });
    };
    try {
      render(<ProjectChatPage projectId="project_1" />);
      await screen.findByText("First conversation");
      fireEvent.click(screen.getByRole("button", { name: /Release notes/ }));
      assert.equal(screen.queryByText("First conversation"), null);
      assert.ok(screen.getByText("Loading conversation"));
      resolveSecond?.([{ id: "message_2", threadId: "chat_2", role: "assistant", content: "Second conversation", createdAt: endpoint.createdAt }]);
      await screen.findByText("Second conversation");
    } finally {
      apiClient.endpoints = original.endpoints;
      apiClient.projectCapabilities = original.projectCapabilities;
      apiClient.chatThreads = original.chatThreads;
      apiClient.chatMessages = original.chatMessages;
    }
  });

  it("selects the pinned remaining thread after deleting the current conversation", async () => {
    const original = { endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities, chatThreads: apiClient.chatThreads, chatMessages: apiClient.chatMessages, deleteChatThread: apiClient.deleteChatThread };
    const current = { ...threads[0]!, id: "chat_current", title: "Current" };
    const pinned = { ...threads[0]!, id: "chat_pinned", title: "Pinned", pinnedAt: "2026-07-11T00:00:00.000Z" };
    const other = { ...threads[0]!, id: "chat_other", title: "Other" };
    const deleted: string[] = [];
    apiClient.endpoints = async () => [endpoint];
    apiClient.projectCapabilities = async () => ({ ...readOnly, canSendChat: true });
    apiClient.chatThreads = async () => [current, other, pinned];
    apiClient.chatMessages = async (_projectId, id) => [{ id: `message_${id}`, threadId: id, role: "assistant", content: `Message for ${id}`, createdAt: endpoint.createdAt }];
    apiClient.deleteChatThread = async (_projectId, id) => { deleted.push(id); return { deleted: true }; };
    try {
      render(<ProjectChatPage projectId="project_1" />);
      await screen.findByText("Message for chat_current");
      const currentRow = screen.getByRole("button", { name: "Current" }).parentElement;
      const remove = currentRow?.querySelector<HTMLButtonElement>("button[aria-label='Delete conversation']");
      assert.ok(remove);
      fireEvent.click(remove);
      const dialog = await screen.findByRole("alertdialog", { name: "Delete conversation" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete conversation" }));
      await waitFor(() => assert.deepEqual(deleted, ["chat_current"]));
      await screen.findByText("Message for chat_pinned");
      assert.equal(screen.getByRole("button", { name: /Pinned/ }).getAttribute("aria-current"), "true");
    } finally {
      apiClient.endpoints = original.endpoints;
      apiClient.projectCapabilities = original.projectCapabilities;
      apiClient.chatThreads = original.chatThreads;
      apiClient.chatMessages = original.chatMessages;
      apiClient.deleteChatThread = original.deleteChatThread;
    }
  });
});

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLTextAreaElement:dom.window.HTMLTextAreaElement, Element: dom.window.Element, Document: dom.window.Document, Node: dom.window.Node,NodeFilter:dom.window.NodeFilter, self: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  if (!("scrollIntoView" in dom.window.HTMLElement.prototype)) Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {} });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
