"use client";

import { RefreshCw } from "lucide-react";
import { type Dispatch,type SetStateAction,useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, type Endpoint, type ProjectCapabilities, type ProjectChatMessage, type ProjectChatThread } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { ChatComposer } from "./ChatComposer";
import { ChatMessageList } from "./ChatMessageList";
import { ChatThreadRail } from "./ChatThreadRail";

export function ProjectChatPage({ projectId }: { projectId: string }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [threads, setThreads] = useState<ProjectChatThread[]>([]);
  const [threadId, setThreadId] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [messages, setMessages] = useState<ProjectChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const messageLoadVersion = useRef(0);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [available, projected, savedThreads] = await Promise.all([apiClient.endpoints(projectId), apiClient.projectCapabilities(projectId), apiClient.chatThreads(projectId)]);
      setEndpoints(available); setCapabilities(projected); setThreads(savedThreads);
      setThreadId((current) => savedThreads.some((thread) => thread.id === current) ? current : (savedThreads[0]?.id ?? ""));
      setEndpointId((current) => available.some((endpoint) => endpoint.id === current) ? current : (savedThreads.find((thread) => thread.endpointId)?.endpointId ?? available[0]?.id ?? ""));
      setError(""); setState("ready");
    } catch (reason) { setError(message(reason)); setState("error"); }
  }, [projectId]);

  const loadMessages = useCallback(async (nextThreadId: string) => {
    const version = ++messageLoadVersion.current;
    setMessages([]);
    if (!nextThreadId) { setMessagesLoading(false); return; }
    setMessagesLoading(true);
    try {
      const saved = await apiClient.chatMessages(projectId, nextThreadId);
      if (version !== messageLoadVersion.current) return;
      setMessages(saved); setError("");
    } catch (reason) {
      if (version === messageLoadVersion.current) setError(message(reason));
    } finally {
      if (version === messageLoadVersion.current) setMessagesLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadMessages(threadId); }, [loadMessages, threadId]);
  useEffect(() => { messageEnd.current?.scrollIntoView({ block: "end" }); }, [messages, sending]);

  const selectedThread = threads.find((thread) => thread.id === threadId);
  const selectedEndpointId = selectedThread ? selectedThread.endpointId : endpointId;
  const endpoint = endpoints.find((item) => item.id === selectedEndpointId);
  const canSend = capabilities?.canSendChat === true;

  function beginNewThread() { ++messageLoadVersion.current; setThreadId(""); setMessages([]); setMessagesLoading(false); setError(""); }

  async function startThread(): Promise<boolean> {
    if (!endpointId || !canSend || sending) return false;
    setError("");
    try {
      const created = await apiClient.createChatThread(projectId, endpointId);
      setThreads((current) => [created, ...current]); setThreadId(created.id); return true;
    } catch (reason) { const detail = message(reason); setError(detail); toast.error(detail); return false; }
  }

  async function selectThread(id: string): Promise<void> {
    if (sending) return;
    const selected = threads.find((thread) => thread.id === id);
    if (!selected) return;
    ++messageLoadVersion.current; setMessages([]); setMessagesLoading(true); setThreadId(id); setEndpointId(selected.endpointId ?? ""); setError("");
  }
  async function updateThread(id:string,input:{title?:string|null;pinned?:boolean;starred?:boolean}){try{const saved=await apiClient.updateChatThread(projectId,id,input);setThreads(current=>orderedThreads(current.map(thread=>thread.id===id?saved:thread)));setError("");}catch(reason){const detail=message(reason);setError(detail);toast.error(detail);}}
  async function removeThread(id:string){try{await apiClient.deleteChatThread(projectId,id);const remaining=threads.filter((thread)=>thread.id!==id);setThreads(remaining);setError("");if(threadId===id){const next=orderedThreads(remaining)[0];if(next){++messageLoadVersion.current;setThreadId(next.id);setEndpointId(next.endpointId ?? "");setMessages([]);setMessagesLoading(true);}else beginNewThread();}}catch(reason){const detail=message(reason);setError(detail);toast.error(detail);}}

  async function send(content: string): Promise<boolean> {
    if (!threadId || !canSend || sending) return false;
    const afterMessageId=messages.filter((item)=>!item.id.startsWith("pending-")&&!item.id.startsWith("stream-")).at(-1)?.id??null;
    const timestamp=new Date().toISOString();const optimistic: ProjectChatMessage = { id: `pending-${Date.now()}`, threadId,sequence:(messages.at(-1)?.sequence??0)+1,version:1,deliveryStatus:"pending", role: "user", content, createdAt: timestamp,updatedAt:timestamp };
    setMessages((current) => [...current, optimistic]); setSending(true); setError("");
    try {
      const controller=new AbortController(); streamAbort.current=controller;
      await apiClient.sendChatMessage(projectId, threadId, content,afterMessageId,controller.signal, (delta)=>appendStreamDelta(threadId,delta,setMessages));
      await loadMessages(threadId);
      const refreshed = await apiClient.chatThreads(projectId); setThreads(refreshed);
      return true;
    } catch (reason) {
      const stopped = isAbort(reason);
      setMessages((current) => current.filter((item) => item.id !== `stream-${threadId}`));
      await loadMessages(threadId);
      if (stopped) return true;
      const detail = message(reason); setError(detail); toast.error(detail); return false;
    } finally { streamAbort.current=null; setSending(false); }
  }
  async function editMessage(target:ProjectChatMessage,content:string){try{await apiClient.editChatMessage(projectId,threadId,target.id,{content,expectedVersion:target.version});await loadMessages(threadId);toast.success("Message updated");}catch(reason){const detail=message(reason);setError(detail);toast.error(detail);}}
  async function deleteMessage(target:ProjectChatMessage){try{await apiClient.deleteChatMessage(projectId,threadId,target.id,target.version);await loadMessages(threadId);toast.success("Message deleted");}catch(reason){const detail=message(reason);setError(detail);toast.error(detail);}}
  async function branchMessage(target:ProjectChatMessage){try{const branch=await apiClient.branchChatMessage(projectId,threadId,target.id,target.version);setThreads((current)=>orderedThreads([branch,...current]));setThreadId(branch.id);setEndpointId(branch.endpointId ?? "");setError("");toast.success("Conversation branched");}catch(reason){const detail=message(reason);setError(detail);toast.error(detail);}}
  async function retryMessage(target:ProjectChatMessage){if(sending)return;setSending(true);setError("");const controller=new AbortController();streamAbort.current=controller;try{await apiClient.retryChatMessage(projectId,threadId,target.id,target.version,controller.signal,(delta)=>appendStreamDelta(threadId,delta,setMessages));await loadMessages(threadId);setThreads(await apiClient.chatThreads(projectId));}catch(reason){setMessages((current)=>current.filter((item)=>item.id!==`stream-${threadId}`));await loadMessages(threadId);if(!isAbort(reason)){const detail=message(reason);setError(detail);toast.error(detail);}}finally{streamAbort.current=null;setSending(false);}}
  function stop(){streamAbort.current?.abort();}

  return <PageLayout contentWidth="full" header={<PageHeader title={selectedThread?.title ?? "Chat"} subtitle={endpoint ? `${endpoint.name} · ${endpoint.model}` : selectedThread ? "Endpoint deleted. Conversation history is read-only." : "Choose an endpoint for a new conversation."} actions={<Button variant="quiet" size="icon" aria-label="Refresh chat" title="Refresh chat" disabled={sending} onClick={() => void load()}><RefreshCw size={17} /></Button>} />}>
    {state === "loading" ? <PageState>Loading chat...</PageState> : null}
    {state === "error" ? <PageState><div className="text-center"><p className="text-error" role="alert">{error}</p><Button className="mt-4" onClick={() => void load()}>Try again</Button></div></PageState> : null}
    {state === "ready" ? <><div className="grid min-h-[calc(100vh-15rem)] border border-border lg:grid-cols-[15rem_minmax(0,1fr)]"><ChatThreadRail threads={threads} endpoints={endpoints} selectedThreadId={threadId} onSelect={(id) => void selectThread(id)} onNewThread={beginNewThread} onRename={(id,title)=>void updateThread(id,{title})} onPin={(id,pinned)=>void updateThread(id,{pinned})} onStar={(id,starred)=>void updateThread(id,{starred})} onDelete={(id)=>void removeThread(id)} disabled={!canSend || sending} /><section className="flex min-h-0 flex-col"><ChatMessageList messages={messages} sending={sending} empty={!selectedThread} loading={messagesLoading} disabled={!canSend} onEdit={(target,content)=>void editMessage(target,content)} onDelete={(target)=>void deleteMessage(target)} onBranch={(target)=>void branchMessage(target)} onRetry={(target)=>void retryMessage(target)}/><div ref={messageEnd} />{sending?<Button variant="danger" className="m-3 w-fit" onClick={stop}>Stop</Button>:null}<ChatComposer endpoints={endpoints} endpointId={endpointId} fixedEndpoint={selectedThread ? endpoint : undefined} canStartThread={canSend && !sending && !selectedThread} onEndpointChange={setEndpointId} onStartThread={startThread} onSend={send} disabled={!canSend || !selectedThread || !endpoint || sending} /></section></div>{error ? <p className="mt-3 text-sm text-error" role="alert">{error}</p> : null}{!canSend ? <p className="mt-3 text-sm text-secondary">Your project access is read-only.</p> : null}{endpoints.length === 0 ? <p className="mt-3 text-sm text-secondary">Add a compatible endpoint before starting a conversation.</p> : null}</> : null}
  </PageLayout>;
}

function message(error: unknown): string { return error instanceof ApiError ? error.message : "The chat request could not be completed."; }

function isAbort(error: unknown): boolean { return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError"; }
function orderedThreads(threads: ProjectChatThread[]): ProjectChatThread[] { return [...threads].sort((left, right) => Number(Boolean(right.starredAt)) - Number(Boolean(left.starredAt)) || Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt))||right.updatedAt.localeCompare(left.updatedAt)); }
function appendStreamDelta(threadId:string,delta:string,setMessages:Dispatch<SetStateAction<ProjectChatMessage[]>>){setMessages(current=>{const last=current.at(-1);const timestamp=new Date().toISOString();return last?.id===`stream-${threadId}`?[...current.slice(0,-1),{...last,content:last.content+delta}]:[...current,{id:`stream-${threadId}`,threadId,sequence:(last?.sequence??0)+1,version:0,deliveryStatus:"pending",role:"assistant",content:delta,createdAt:timestamp,updatedAt:timestamp}];});}
