"use client";

import { MessagesSquare, RefreshCw, X } from "lucide-react";
import { type Dispatch, type ReactNode, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, type Endpoint, type ProjectCapabilities, type ProjectChatMessage, type ProjectChatThread } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { Button } from "../ui/button";
import { Sheet, SheetContent } from "../ui/sheet";
import { toast } from "../ui/toast";
import { ChatComposer } from "./ChatComposer";
import { ChatMessageList } from "./ChatMessageList";
import { ChatThreadRail } from "./ChatThreadRail";

type LoadStatus = "loading" | "ready" | "error";
type MessageStatus = "idle" | LoadStatus;

export function ProjectChatPage({ projectId }: { projectId: string }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [endpointsStatus, setEndpointsStatus] = useState<LoadStatus>("loading");
  const [endpointsError, setEndpointsError] = useState("");
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<LoadStatus>("loading");
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const [threads, setThreads] = useState<ProjectChatThread[]>([]);
  const [threadsStatus, setThreadsStatus] = useState<LoadStatus>("loading");
  const [threadsError, setThreadsError] = useState("");
  const [threadId, setThreadId] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [messages, setMessages] = useState<ProjectChatMessage[]>([]);
  const [messagesStatus, setMessagesStatus] = useState<MessageStatus>("idle");
  const [messagesError, setMessagesError] = useState("");
  const [actionError, setActionError] = useState("");
  const [sending, setSending] = useState(false);
  const [threadSheetOpen, setThreadSheetOpen] = useState(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const messageLoadVersion = useRef(0);
  const loadedThreadId = useRef("");

  const loadEndpoints = useCallback(async () => {
    setEndpointsStatus("loading");
    try {
      const available = await apiClient.endpoints(projectId);
      setEndpoints(available);
      setEndpointId((current) => available.some((endpoint) => endpoint.id === current) ? current : (available[0]?.id ?? ""));
      setEndpointsError("");
      setEndpointsStatus("ready");
    } catch (reason) {
      setEndpointsError(message(reason));
      setEndpointsStatus("error");
    }
  }, [projectId]);

  const loadCapabilities = useCallback(async () => {
    setCapabilitiesStatus("loading");
    try {
      setCapabilities(await apiClient.projectCapabilities(projectId));
      setCapabilitiesError("");
      setCapabilitiesStatus("ready");
    } catch (reason) {
      setCapabilitiesError(message(reason));
      setCapabilitiesStatus("error");
    }
  }, [projectId]);

  const loadThreads = useCallback(async () => {
    setThreadsStatus("loading");
    try {
      const savedThreads = await apiClient.chatThreads(projectId);
      setThreads(savedThreads);
      setThreadId((current) => savedThreads.some((thread) => thread.id === current) ? current : (savedThreads[0]?.id ?? ""));
      setThreadsError("");
      setThreadsStatus("ready");
    } catch (reason) {
      setThreadsError(message(reason));
      setThreadsStatus("error");
    }
  }, [projectId]);

  const loadMessages = useCallback(async (nextThreadId: string): Promise<boolean> => {
    const version = ++messageLoadVersion.current;
    if (!nextThreadId) {
      loadedThreadId.current = "";
      setMessages([]);
      setMessagesError("");
      setMessagesStatus("idle");
      return true;
    }
    if (loadedThreadId.current !== nextThreadId) setMessages([]);
    setMessagesError("");
    setMessagesStatus("loading");
    try {
      const saved = await apiClient.chatMessages(projectId, nextThreadId);
      if (version !== messageLoadVersion.current) return false;
      loadedThreadId.current = nextThreadId;
      setMessages(saved);
      setMessagesStatus("ready");
      return true;
    } catch (reason) {
      if (version !== messageLoadVersion.current) return false;
      setMessagesError(message(reason));
      setMessagesStatus("error");
      return false;
    }
  }, [projectId]);

  useEffect(() => {
    void loadEndpoints();
    void loadCapabilities();
    void loadThreads();
  }, [loadCapabilities, loadEndpoints, loadThreads]);
  useEffect(() => { void loadMessages(threadId); }, [loadMessages, threadId]);
  useEffect(() => { messageEnd.current?.scrollIntoView({ block: "end" }); }, [messages, sending]);

  const selectedThread = threads.find((thread) => thread.id === threadId);
  const selectedEndpointId = selectedThread ? selectedThread.endpointId : endpointId;
  const endpoint = endpoints.find((item) => item.id === selectedEndpointId);
  const canSend = capabilitiesStatus === "ready" && capabilities?.canSendChat === true;
  const historyReady = messagesStatus === "ready" && loadedThreadId.current === threadId;

  function refresh() {
    void loadEndpoints();
    void loadCapabilities();
    void loadThreads();
    if (threadId) void loadMessages(threadId);
  }

  function beginNewThread() {
    ++messageLoadVersion.current;
    loadedThreadId.current = "";
    setThreadId("");
    setMessages([]);
    setMessagesError("");
    setMessagesStatus("idle");
    setActionError("");
  }

  async function startThread(): Promise<boolean> {
    if (!endpointId || !canSend || sending || endpointsStatus !== "ready") return false;
    setActionError("");
    try {
      const created = await apiClient.createChatThread(projectId, endpointId);
      setThreads((current) => orderedThreads([created, ...current]));
      setThreadId(created.id);
      return true;
    } catch (reason) {
      return failAction(reason);
    }
  }

  function selectThread(id: string): void {
    if (sending || id === threadId) return;
    const selected = threads.find((thread) => thread.id === id);
    if (!selected) return;
    ++messageLoadVersion.current;
    setMessages([]);
    setMessagesError("");
    setMessagesStatus("loading");
    setThreadId(id);
    setEndpointId(selected.endpointId ?? "");
    setActionError("");
  }

  async function updateThread(id: string, input: { title?: string | null; pinned?: boolean; starred?: boolean }) {
    try {
      const saved = await apiClient.updateChatThread(projectId, id, input);
      setThreads((current) => orderedThreads(current.map((thread) => thread.id === id ? saved : thread)));
      setActionError("");
    } catch (reason) {
      failAction(reason);
    }
  }

  async function removeThread(id: string) {
    try {
      await apiClient.deleteChatThread(projectId, id);
      const remaining = threads.filter((thread) => thread.id !== id);
      setThreads(remaining);
      setActionError("");
      if (threadId !== id) return;
      const next = orderedThreads(remaining)[0];
      if (!next) {
        beginNewThread();
        return;
      }
      ++messageLoadVersion.current;
      setMessages([]);
      setMessagesError("");
      setMessagesStatus("loading");
      setThreadId(next.id);
      setEndpointId(next.endpointId ?? "");
    } catch (reason) {
      failAction(reason);
    }
  }

  async function send(content: string): Promise<boolean> {
    if (!threadId || !canSend || sending || !endpoint || !historyReady) return false;
    const afterMessageId = latestConfirmedMessageId(messages);
    const timestamp = new Date().toISOString();
    const optimistic: ProjectChatMessage = {
      id: `pending-${Date.now()}`,
      threadId,
      sequence: (messages.at(-1)?.sequence ?? 0) + 1,
      version: 1,
      deliveryStatus: "pending",
      role: "user",
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    setMessages((current) => [...current, optimistic]);
    setSending(true);
    setActionError("");
    try {
      const controller = new AbortController();
      streamAbort.current = controller;
      await apiClient.sendChatMessage(projectId, threadId, content, afterMessageId, controller.signal, (delta) => appendStreamDelta(threadId, delta, setMessages));
      await loadMessages(threadId);
      void loadThreads();
      return true;
    } catch (reason) {
      const stopped = isAbort(reason);
      setMessages((current) => current.filter((item) => item.id !== `stream-${threadId}`));
      await loadMessages(threadId);
      if (stopped) return true;
      return failAction(reason);
    } finally {
      streamAbort.current = null;
      setSending(false);
    }
  }

  async function editMessage(target: ProjectChatMessage, content: string) {
    try {
      await apiClient.editChatMessage(projectId, threadId, target.id, { content, expectedVersion: target.version });
      await loadMessages(threadId);
      toast.success("Message updated");
    } catch (reason) {
      failAction(reason);
    }
  }

  async function deleteMessage(target: ProjectChatMessage) {
    try {
      await apiClient.deleteChatMessage(projectId, threadId, target.id, target.version);
      await loadMessages(threadId);
      toast.success("Message deleted");
    } catch (reason) {
      failAction(reason);
    }
  }

  async function branchMessage(target: ProjectChatMessage) {
    try {
      const branch = await apiClient.branchChatMessage(projectId, threadId, target.id, target.version);
      setThreads((current) => orderedThreads([branch, ...current]));
      ++messageLoadVersion.current;
      setMessages([]);
      setMessagesError("");
      setMessagesStatus("loading");
      setThreadId(branch.id);
      setEndpointId(branch.endpointId ?? "");
      setActionError("");
      toast.success("Conversation branched");
    } catch (reason) {
      failAction(reason);
    }
  }

  async function retryMessage(target: ProjectChatMessage) {
    if (sending || !historyReady) return;
    setSending(true);
    setActionError("");
    const controller = new AbortController();
    streamAbort.current = controller;
    try {
      await apiClient.retryChatMessage(projectId, threadId, target.id, target.version, controller.signal, (delta) => appendStreamDelta(threadId, delta, setMessages));
      await loadMessages(threadId);
      void loadThreads();
    } catch (reason) {
      setMessages((current) => current.filter((item) => item.id !== `stream-${threadId}`));
      await loadMessages(threadId);
      if (!isAbort(reason)) failAction(reason);
    } finally {
      streamAbort.current = null;
      setSending(false);
    }
  }

  function failAction(reason: unknown): false {
    const detail = message(reason);
    setActionError(detail);
    toast.error(detail);
    return false;
  }

  function stop() { streamAbort.current?.abort(); }

  const threadRail = (mobile: boolean) => <ChatThreadRail
    className={mobile ? "min-h-0 flex-1 border-0" : "h-full border-r"}
    threads={threads}
    endpoints={endpoints}
    selectedThreadId={threadId}
    loading={threadsStatus === "loading"}
    error={threadsStatus === "error" ? threadsError : ""}
    onRetry={() => void loadThreads()}
    onSelect={(id) => { selectThread(id); if (mobile) setThreadSheetOpen(false); }}
    onNewThread={() => { beginNewThread(); if (mobile) setThreadSheetOpen(false); }}
    onRename={(id, title) => void updateThread(id, { title })}
    onPin={(id, pinned) => void updateThread(id, { pinned })}
    onStar={(id, starred) => void updateThread(id, { starred })}
    onDelete={(id) => void removeThread(id)}
    disabled={!canSend || sending}
  />;

  const subtitle = endpoint
    ? `${endpoint.name} · ${endpoint.model}`
    : selectedThread
      ? endpointsStatus === "loading"
        ? "Loading endpoint details..."
        : endpointsStatus === "error"
          ? "Endpoint details unavailable. Conversation history remains available."
          : "Endpoint deleted. Conversation history is read-only."
      : "Choose an endpoint for a new conversation.";

  return <PageLayout contentWidth="full" header={<PageHeader title={selectedThread?.title ?? "Chat"} subtitle={subtitle} actions={<Button variant="quiet" size="icon" aria-label="Refresh chat" title="Refresh chat" disabled={sending} onClick={refresh}><RefreshCw size={17} /></Button>} />}>
    <div className="grid h-[calc(100dvh-12rem)] min-h-[30rem] overflow-hidden border border-border lg:h-[calc(100vh-15rem)] lg:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="hidden min-h-0 lg:block" aria-hidden={threadSheetOpen || undefined}>{threadRail(false)}</div>
      <section className="flex min-h-0 min-w-0 flex-col">
        <div className="flex items-center justify-between border-b border-border bg-surface-low px-3 py-2 lg:hidden">
          <Button variant="quiet" onClick={() => setThreadSheetOpen(true)} aria-label="Open conversations"><MessagesSquare size={16} />Conversations</Button>
          <span className="max-w-[55%] truncate text-xs text-secondary">{selectedThread?.title ?? "New conversation"}</span>
        </div>
        <ChatMessageList
          messages={messages}
          sending={sending}
          empty={!selectedThread}
          loading={Boolean(selectedThread) && messagesStatus === "loading"}
          error={messagesStatus === "error" ? messagesError : ""}
          disabled={!canSend || !historyReady}
          onReload={() => void loadMessages(threadId)}
          onEdit={(target, content) => void editMessage(target, content)}
          onDelete={(target) => void deleteMessage(target)}
          onBranch={(target) => void branchMessage(target)}
          onRetry={(target) => void retryMessage(target)}
        />
        <div ref={messageEnd} />
        {sending ? <Button variant="danger" className="m-3 w-fit" onClick={stop}>Stop</Button> : null}
        <ChatComposer
          endpoints={endpoints}
          endpointId={endpointId}
          hasThread={Boolean(selectedThread)}
          fixedEndpoint={selectedThread ? endpoint : undefined}
          canStartThread={canSend && !sending && !selectedThread && endpointsStatus === "ready"}
          onEndpointChange={setEndpointId}
          onStartThread={startThread}
          onSend={send}
          disabled={!canSend || !selectedThread || !endpoint || sending || !historyReady}
        />
      </section>
    </div>
    <Sheet open={threadSheetOpen} onOpenChange={setThreadSheetOpen}>
      <SheetContent className="lg:hidden" accessibleTitle="Conversations" aria-describedby={undefined}>
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
          <h2 className="type-title">Conversations</h2>
          <Button variant="quiet" size="icon" aria-label="Close conversations" onClick={() => setThreadSheetOpen(false)}><X size={17} /></Button>
        </div>
        {threadRail(true)}
      </SheetContent>
    </Sheet>
    <div className="space-y-2" aria-live="polite">
      {capabilitiesStatus === "loading" ? <Notice>Checking project access...</Notice> : null}
      {capabilitiesStatus === "error" ? <Notice error action="Retry access" onAction={() => void loadCapabilities()}>Project access could not be loaded. Sending is unavailable. {capabilitiesError}</Notice> : null}
      {capabilitiesStatus === "ready" && !canSend ? <Notice>Your project access is read-only.</Notice> : null}
      {endpointsStatus === "loading" ? <Notice>Loading compatible endpoints...</Notice> : null}
      {endpointsStatus === "error" ? <Notice error action="Retry endpoints" onAction={() => void loadEndpoints()}>Endpoint configuration could not be loaded. Existing conversation history remains available. {endpointsError}</Notice> : null}
      {endpointsStatus === "ready" && endpoints.length === 0 ? <Notice>Add a compatible endpoint before starting a conversation.</Notice> : null}
      {actionError ? <Notice error>{actionError}</Notice> : null}
    </div>
  </PageLayout>;
}

function Notice({ children, error = false, action, onAction }: { children: ReactNode; error?: boolean; action?: string; onAction?: () => void }) {
  return <div className={`flex flex-wrap items-center gap-2 text-sm ${error ? "text-error" : "text-secondary"}`} role={error ? "alert" : "status"}><span>{children}</span>{action && onAction ? <Button size="sm" variant="outline" onClick={onAction}>{action}</Button> : null}</div>;
}

function message(error: unknown): string { return error instanceof ApiError ? error.message : "The chat request could not be completed."; }
function isAbort(error: unknown): boolean { return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError"; }
function orderedThreads(threads: ProjectChatThread[]): ProjectChatThread[] { return [...threads].sort((left, right) => Number(Boolean(right.starredAt)) - Number(Boolean(left.starredAt)) || Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt)) || right.updatedAt.localeCompare(left.updatedAt)); }
function latestConfirmedMessageId(messages: ProjectChatMessage[]): string | null { return messages.filter((item) => !item.id.startsWith("pending-") && !item.id.startsWith("stream-")).reduce<ProjectChatMessage | undefined>((latest, item) => !latest || item.sequence > latest.sequence ? item : latest, undefined)?.id ?? null; }
function appendStreamDelta(threadId: string, delta: string, setMessages: Dispatch<SetStateAction<ProjectChatMessage[]>>) { setMessages((current) => { const last = current.at(-1); const timestamp = new Date().toISOString(); return last?.id === `stream-${threadId}` ? [...current.slice(0, -1), { ...last, content: last.content + delta }] : [...current, { id: `stream-${threadId}`, threadId, sequence: (last?.sequence ?? 0) + 1, version: 0, deliveryStatus: "pending", role: "assistant", content: delta, createdAt: timestamp, updatedAt: timestamp }]; }); }
