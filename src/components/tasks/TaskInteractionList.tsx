"use client";

import { Check, CheckCircle2, CircleAlert, Clock3, Copy, FileOutput, Loader2, Square, Wrench } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { TaskInteractionItem, TaskInteractionStreamEvent } from "../../lib/api/client";
import { Markdown } from "../ui/markdown";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { Tooltip, TooltipContent, TooltipProvider } from "../ui/tooltip";
import { TaskArtifactActions } from "./TaskArtifactActions";
import { upsertTaskInteractions } from "./task-conversation-state";
import { formatArtifactBytes, formatTaskDate } from "./task-ui";

export type AssistantPreview = Extract<TaskInteractionStreamEvent, { type: "assistant_preview" }> | null;

export { upsertTaskInteractions } from "./task-conversation-state";

export function TaskInteractionList({ taskId, items, preview, basePath, onStopWork }: { taskId: string; items: TaskInteractionItem[]; preview: AssistantPreview; basePath: string; onStopWork: (interactionId: string) => Promise<void> }) {
  if (items.length === 0 && !preview) return <div className="grid min-h-52 place-items-center border border-dashed border-border px-5 text-center"><div><Loader2 className="mx-auto size-5 animate-spin text-icon-default" /><p className="mt-2 text-sm text-secondary">Waiting for task messages.</p></div></div>;
  return <TooltipProvider><ol className="space-y-3" aria-label="Task interactions">{items.map((item) => <TaskInteractionItemView key={item.id} taskId={taskId} item={item} basePath={basePath} onStopWork={onStopWork} />)}{preview ? <li><article className="border-l-2 border-accent bg-surface-low px-4 py-3"><ItemHeader title="Assistant" timestamp={null} status="Generating" /><p className="mt-2 text-xs text-secondary">Preview only</p><div className="mt-2"><Markdown content={preview.body} /></div></article></li> : null}</ol></TooltipProvider>;
}

function TaskInteractionItemView({ taskId, item, basePath, onStopWork }: { taskId: string; item: TaskInteractionItem; basePath: string; onStopWork: (interactionId: string) => Promise<void> }) {
  switch (item.kind) {
    case "user_message": return <UserMessage item={item} />;
    case "assistant_message": return <AssistantMessage item={item} />;
    case "tool": return <WorkItem item={item} icon={<Wrench size={16} />} onStopWork={onStopWork} />;
    case "background_task": return <WorkItem item={item} icon={<Loader2 size={16} />} onStopWork={onStopWork} />;
    case "task_question": return <NoticeItem item={item} label="Question" />;
    case "task_notice": return <NoticeItem item={item} label="Notice" />;
    case "task_result": return <WorkItem item={item} icon={<CheckCircle2 size={16} />} onStopWork={onStopWork} />;
    case "subagent_result": return <WorkItem item={item} icon={<CheckCircle2 size={16} />} onStopWork={onStopWork} />;
    case "file": return <FileItem taskId={taskId} item={item} />;
    case "execution_boundary": return <ExecutionBoundary item={item} basePath={basePath} />;
    case "system_error": return <SystemError item={item} />;
    default: return assertNever(item);
  }
}

function UserMessage({ item }: { item: Extract<TaskInteractionItem, { kind: "user_message" }> }) {
  return <li><article className="border-l-2 border-border bg-background px-4 py-3"><ItemHeader title="You" timestamp={item.occurredAt} status={item.status} /><ContentNotice contentMode={item.contentMode} />{item.body ? <div className="mt-2"><Markdown content={item.body} /></div> : null}</article></li>;
}

function AssistantMessage({ item }: { item: Extract<TaskInteractionItem, { kind: "assistant_message" }> }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!item.body) return;
    try {
      await navigator.clipboard.writeText(item.body);
      setCopied(true);
      toast.success("Message copied");
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error("Message could not be copied");
    }
  }
  const action = item.body ? <Tooltip.Root><Tooltip.Trigger asChild><button type="button" className="grid size-7 place-items-center text-tertiary opacity-0 transition-opacity hover:bg-hover hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100" aria-label="Copy message" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></Tooltip.Trigger><TooltipContent>Copy message</TooltipContent></Tooltip.Root> : null;
  return <li><article className="group border-l-2 border-accent bg-surface-low px-4 py-3"><ItemHeader title="Assistant" timestamp={item.occurredAt} status={item.status} action={action} /><ContentNotice contentMode={item.contentMode} />{item.body ? <div className="mt-2"><Markdown content={item.body} /></div> : null}</article></li>;
}

function WorkItem({ item, icon, onStopWork }: { item: Extract<TaskInteractionItem, { kind: "tool" | "background_task" | "task_result" | "subagent_result" }>; icon: ReactNode; onStopWork: (interactionId: string) => Promise<void> }) {
  const status = item.executionStatus;
  const canStop = (item.kind === "tool" || item.kind === "background_task") && item.canStop;
  const summary = workSummary(item);
  const details = workDetails(item);
  return <li><article className="border-l-2 border-warning/60 px-4 py-3"><div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-2 text-foreground">{icon}<div className="min-w-0"><p className="truncate text-sm font-medium">{workTitle(item)}</p><p className="mt-0.5 text-xs text-secondary">{statusLabel(status)}{item.deliveryStatus ? ` · delivery ${statusLabel(item.deliveryStatus)}` : ""}</p></div></div>{canStop ? <Button variant="quiet" size="sm" onClick={() => void onStopWork(item.id)}><Square size={14} />Stop work</Button> : null}</div><ContentNotice contentMode={item.contentMode} detailsOmitted={item.detailsOmitted} />{summary ? <p className={`mt-2 max-h-10 overflow-hidden whitespace-pre-wrap break-all text-xs leading-5 text-secondary ${item.kind === "tool" ? "font-mono" : ""}`}>{summary}</p> : null}{details ? <details className="mt-3"><summary className="cursor-pointer text-sm text-secondary">Execution details</summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words border border-border bg-surface-high p-3 font-mono text-xs leading-5 text-secondary">{details}</pre></details> : null}</article></li>;
}

function NoticeItem({ item, label }: { item: Extract<TaskInteractionItem, { kind: "task_question" | "task_notice" }>; label: string }) {
  const detail = item.kind === "task_question" ? [item.question, item.expect ? `Expected: ${item.expect}` : null, item.answer ? `Answer: ${item.answer}` : null].filter(Boolean).join("\n\n") : item.body;
  const title = item.kind === "task_notice" && item.sender ? `${label} from ${item.sender}` : item.title || label;
  return <li><article className="border-l-2 border-border px-4 py-3"><ItemHeader title={title} timestamp={item.occurredAt} status={item.status} />{detail ? <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-secondary">{detail}</p> : null}</article></li>;
}

function FileItem({ taskId, item }: { taskId: string; item: Extract<TaskInteractionItem, { kind: "file" }> }) {
  const available = item.status === "available";
  return <li><article className={`border-l-2 px-4 py-3 ${available ? "border-success/60" : "border-error/60 bg-error/5"}`}><div className="flex min-w-0 gap-2"><FileOutput className="mt-0.5 size-4 shrink-0 text-icon-default" /><div className="min-w-0"><p className="break-words text-sm font-medium text-foreground">{item.name}</p><p className={`mt-1 text-xs ${available ? "text-secondary" : "text-error"}`}>{available ? [item.mediaType, formatArtifactBytes(item.bytes)].filter(Boolean).join(" · ") : "Artifact unavailable"}</p></div></div><TaskArtifactActions taskId={taskId} artifact={{ id: item.artifactId, name: item.name, mediaType: item.mediaType, bytes: item.bytes }} available={available} className="mt-2" />{item.body ? <p className={`mt-2 whitespace-pre-wrap break-words text-sm ${available ? "text-secondary" : "text-error"}`}>{item.body}</p> : null}</article></li>;
}

function ExecutionBoundary({ item, basePath }: { item: Extract<TaskInteractionItem, { kind: "execution_boundary" }>; basePath: string }) {
  return <li><article className="border border-border bg-surface-low px-4 py-3"><ItemHeader title="Continued in new execution" timestamp={item.occurredAt} status={item.status} />{item.body ? <p className="mt-2 text-sm text-secondary">{item.body}</p> : null}{item.targetTaskId ? <Link className="mt-3 inline-flex text-sm text-foreground underline underline-offset-2" href={`${basePath}/${item.targetTaskId}`}>Open new execution</Link> : null}</article></li>;
}

function SystemError({ item }: { item: Extract<TaskInteractionItem, { kind: "system_error" }> }) {
  return <li><article className="border border-error/30 bg-error/10 px-4 py-3" role="alert"><div className="flex gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0 text-error" /><div className="min-w-0 flex-1"><ItemHeader title={item.title || "Task issue"} timestamp={item.occurredAt} status={item.status} /><ContentNotice contentMode={item.contentMode} detailsOmitted={item.detailsOmitted} />{item.body ? <p className="mt-2 whitespace-pre-wrap break-words text-sm text-error">{item.body}</p> : null}<p className="mt-2 text-xs text-secondary">{item.retryable ? "Retryable" : "Not retryable"}</p></div></div></article></li>;
}

function ContentNotice({ contentMode, detailsOmitted = false }: { contentMode: TaskInteractionItem["contentMode"]; detailsOmitted?: boolean }) {
  const labels = [contentMode === "preview" ? "Preview only" : contentMode === "none" ? "Content omitted" : null, detailsOmitted ? "Some details omitted" : null].filter(Boolean);
  return labels.length > 0 ? <p className="mt-2 text-xs text-secondary">{labels.join(" · ")}</p> : null;
}

function ItemHeader({ title, timestamp, status, action }: { title: string; timestamp: string | null; status: string | null; action?: ReactNode }) {
  return <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><div className="flex min-w-0 items-center gap-1"><p className="text-sm font-medium text-foreground">{title}</p>{action}</div><div className="flex items-center gap-2">{status ? <span className="font-mono text-[10px] uppercase text-tertiary">{statusLabel(status)}</span> : null}{timestamp ? <time className="inline-flex items-center gap-1 font-mono text-[10px] text-tertiary"><Clock3 size={11} />{formatTaskDate(timestamp)}</time> : null}</div></div>;
}

function statusLabel(status: string): string { return status.replaceAll("_", " "); }
function workTitle(item: Extract<TaskInteractionItem, { kind: "tool" | "background_task" | "task_result" | "subagent_result" }>): string { return item.kind === "tool" ? item.toolName : item.kind === "background_task" ? item.label : item.kind === "subagent_result" ? item.name : item.title; }
function workSummary(item: Extract<TaskInteractionItem, { kind: "tool" | "background_task" | "task_result" | "subagent_result" }>): string | null { return item.kind === "tool" ? item.command : item.kind === "background_task" ? item.workSummary : item.kind === "subagent_result" ? item.purpose : null; }
function workDetails(item: Extract<TaskInteractionItem, { kind: "tool" | "background_task" | "task_result" | "subagent_result" }>): string | null { if (item.kind === "tool") return [item.command, item.outputTail, item.exitCode === null ? null : `Exit code: ${item.exitCode}`].filter(Boolean).join("\n\n") || null; if (item.kind === "background_task") return [item.workSummary, item.result, item.error].filter(Boolean).join("\n\n") || null; if (item.kind === "task_result" || item.kind === "subagent_result") return [item.result, item.error].filter(Boolean).join("\n\n") || null; return null; }
function assertNever(value: never): never { throw new Error(`Unsupported task interaction: ${String(value)}`); }
