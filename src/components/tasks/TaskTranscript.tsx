"use client";

import { CircleAlert, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiClient, type TaskTranscriptEntry } from "../../lib/api/client";
import { Button } from "../ui/button";
import { Markdown } from "../ui/markdown";
import { formatTaskDate } from "./task-ui";

type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected" | "recovered";

export function TaskTranscript({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<TaskTranscriptEntry[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const cursor = useRef<string | undefined>(undefined);
  const retry = useRef(0);
  const connectedOnce = useRef(false);
  const initializedTaskId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (initializedTaskId.current !== taskId) {
      initializedTaskId.current = taskId;
      cursor.current = undefined;
      retry.current = 0;
      connectedOnce.current = false;
      setItems([]);
      setError("");
      setConnection("connecting");
    }
    let stopped = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async (manual = false) => {
      if (stopped) return;
      controller?.abort();
      controller = new AbortController();
      setConnection(manual || retry.current > 0 || connectedOnce.current ? "reconnecting" : "connecting");
      try {
        await apiClient.streamTaskTranscript(taskId, cursor.current, controller.signal, (entry) => {
          cursor.current = entry.cursor;
          setItems((current) => current.some((item) => item.id === entry.id) ? current : [...current, entry]);
        }, (nextCursor) => { if (nextCursor) cursor.current = nextCursor; });
        if (stopped) return;
        const recovered = retry.current > 0;
        retry.current = 0;
        connectedOnce.current = true;
        setError("");
        setConnection(recovered ? "recovered" : "connected");
        timer = setTimeout(() => void connect(), recovered ? 1_000 : 1_500);
      } catch (reason) {
        if (stopped || controller.signal.aborted) return;
        retry.current += 1;
        setConnection("disconnected");
        setError(reason instanceof Error ? reason.message : "Task transcript is unavailable.");
        timer = setTimeout(() => void connect(), Math.min(5_000, 1_000 * retry.current));
      }
    };

    void connect();
    return () => { stopped = true; controller?.abort(); if (timer) clearTimeout(timer); };
  }, [generation, taskId]);

  function retryNow() {
    retry.current = Math.max(1, retry.current);
    setError("");
    setConnection("reconnecting");
    setGeneration((value) => value + 1);
  }

  return <section aria-label="Task conversation">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="type-title text-foreground">Conversation</h2><ConnectionStatus state={connection} /></div>
    {connection === "disconnected" && error ? <div className="mb-4 flex items-start justify-between gap-3 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert"><span className="flex items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" />{error}</span><Button variant="quiet" size="sm" onClick={retryNow}><RefreshCw size={14} />Retry</Button></div> : null}
    {items.length === 0 ? <div className="grid min-h-40 place-items-center border border-dashed border-border px-5 text-center"><div>{connection === "connecting" || connection === "reconnecting" ? <Loader2 className="mx-auto size-5 animate-spin text-icon-default" /> : null}<p className="mt-2 text-sm text-secondary">{connection === "disconnected" ? "Conversation history could not be reached." : "Waiting for task messages."}</p></div></div> : <ol className="space-y-4">{items.map((entry) => <TranscriptMessage key={entry.id} entry={entry} />)}</ol>}
  </section>;
}

function ConnectionStatus({ state }: { state: ConnectionState }) {
  const label = state === "connected" ? "Connected" : state === "connecting" ? "Connecting" : state === "reconnecting" ? "Reconnecting" : state === "recovered" ? "Recovered" : "Disconnected";
  const color = state === "disconnected" ? "border-error/40 text-error" : state === "recovered" || state === "connected" ? "border-success/40 text-success" : "border-border text-secondary";
  return <span className={`border px-2 py-1 font-mono text-[10px] uppercase ${color}`} role="status">{label}</span>;
}

function TranscriptMessage({ entry }: { entry: TaskTranscriptEntry }) {
  const author = entry.role === "assistant" ? "Assistant" : entry.role === "user" ? "You" : entry.role === "tool" ? "Tool" : "System";
  const header = <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-sm font-medium text-foreground">{author}</p><time className="font-mono text-[10px] text-tertiary">{formatTaskDate(entry.createdAt)}</time></div>;
  if (entry.role === "tool") return <li className="border-l-2 border-warning/60 px-4 py-3"><details><summary className="cursor-pointer list-none">{header}<p className="mt-1 text-xs text-secondary">Tool output is available</p></summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words border border-border bg-surface-high p-3 text-xs text-secondary">{entry.text}</pre></details></li>;
  return <li className={`border-l-2 px-4 py-3 ${entry.role === "assistant" ? "border-accent bg-surface-low" : "border-border"}`}>{header}<div className="mt-2"><Markdown content={entry.text} /></div></li>;
}
