"use client";

import { Check, CheckCircle2, CircleAlert, Clock3, Copy, FileOutput, Loader2, Wrench } from "lucide-react";
import { Banner, Collapsible, IconButton, Markdown, Spinner, Text } from "@astryxdesign/core";
import { memo, useState, type ReactNode } from "react";
import type { TaskInteractionItem } from "../../lib/api/client";
import { TaskArtifactActions } from "./TaskArtifactActions";
import type { TaskAssistantPreview } from "./task-conversation-state";
import { formatArtifactBytes, formatTaskDate } from "./task-ui";

export function TaskInteractionList({ taskId, items, preview }: { taskId: string; items: TaskInteractionItem[]; preview: TaskAssistantPreview }) {
  if (items.length === 0 && !preview) return <div className="grid min-h-52 place-items-center border border-dashed border-border px-5 text-center"><Spinner label="Waiting for task messages." /></div>;
  return <ol className="space-y-3" aria-label="Task interactions"><SettledTaskInteractionItems taskId={taskId} items={items} />{preview ? <li><article className="border-l-2 border-accent bg-muted px-4 py-3"><ItemHeader title="Assistant" timestamp={null} status="Generating" /><Text display="block" type="supporting" color="secondary" className="mt-2">Preview only</Text><Text as="div" display="block" type="supporting" className="mt-2 whitespace-pre-wrap break-words">{preview.body}</Text></article></li> : null}</ol>;
}

const SettledTaskInteractionItems = memo(function SettledTaskInteractionItems({ taskId, items }: { taskId: string; items: TaskInteractionItem[] }) {
  return <>{items.map((item) => <TaskInteractionItemView key={item.id} taskId={taskId} item={item} />)}</>;
});

const TaskInteractionItemView = memo(function TaskInteractionItemView({ taskId, item }: { taskId: string; item: TaskInteractionItem }) {
  let content: ReactNode;
  switch (item.kind) {
    case "user_message": content = <UserMessage item={item} />; break;
    case "assistant_message": content = <AssistantMessage item={item} />; break;
    case "tool": content = <WorkItem item={item} icon={<Wrench size={16} />} />; break;
    case "background_task": content = <WorkItem item={item} icon={<Loader2 size={16} />} />; break;
    case "task_question": content = <NoticeItem item={item} label="Question" />; break;
    case "task_notice": content = <NoticeItem item={item} label="Notice" />; break;
    case "task_result": content = <WorkItem item={item} icon={<CheckCircle2 size={16} />} />; break;
    case "subagent_result": content = <WorkItem item={item} icon={<CheckCircle2 size={16} />} />; break;
    case "file": content = <FileItem taskId={taskId} item={item} />; break;
    case "system_error": content = <SystemError item={item} />; break;
    default: return assertNever(item);
  }
  return <li data-interaction-id={item.id}>{content}</li>;
});

function UserMessage({ item }: { item: Extract<TaskInteractionItem, { kind: "user_message" }> }) {
  return <article className="border-l-2 border-border bg-surface px-4 py-3"><ItemHeader title={item.title||"Project member"} timestamp={item.occurredAt} status={item.status} /><ContentNotice contentMode={item.contentMode} />{item.body ? <div className="mt-2"><Markdown density="compact">{item.body}</Markdown></div> : null}</article>;
}

function AssistantMessage({ item }: { item: Extract<TaskInteractionItem, { kind: "assistant_message" }> }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  async function copy() {
    if (!item.body) return;
    try {
      await navigator.clipboard.writeText(item.body);
      setCopyError("");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopyError("Your browser did not allow this message to be copied. Select the text and copy it manually.");
    }
  }
  const action = item.body ? <IconButton label={copied ? "Message copied" : "Copy message"} tooltip={copied ? "Message copied" : "Copy message"} variant="ghost" size="sm" icon={copied ? <Check size={15} /> : <Copy size={15} />} onClick={() => void copy()} /> : null;
  return <article className="border-l-2 border-accent bg-muted px-4 py-3"><ItemHeader title="Assistant" timestamp={item.occurredAt} status={item.status} action={action} />{copyError ? <Banner className="mt-2" status="error" title="Message could not be copied" description={copyError} isDismissable onDismiss={() => setCopyError("")} /> : null}<ContentNotice contentMode={item.contentMode} />{item.body ? <div className="mt-2"><Markdown density="compact">{item.body}</Markdown></div> : null}</article>;
}

function WorkItem({ item, icon }: { item: Extract<TaskInteractionItem, { kind: "tool" | "background_task" | "task_result" | "subagent_result" }>; icon: ReactNode }) {
  const status = item.executionStatus;
  const summary = workSummary(item);
  const details = workDetails(item);
  return <article className="border-l-2 border-warning px-4 py-3"><div className="flex min-w-0 items-center gap-2 text-primary">{icon}<div className="min-w-0"><Text display="block" type="supporting" weight="medium" className="truncate">{workTitle(item)}</Text><Text display="block" type="supporting" color="secondary" className="mt-0.5">{statusLabel(status)}{item.deliveryStatus ? ` · delivery ${statusLabel(item.deliveryStatus)}` : ""}</Text></div></div><ContentNotice contentMode={item.contentMode} detailsOmitted={item.detailsOmitted} />{summary ? <Text display="block" type={item.kind === "tool" ? "code" : "supporting"} color="secondary" className="mt-2 max-h-10 overflow-hidden whitespace-pre-wrap break-all">{summary}</Text> : null}{details ? <div className="mt-3"><Collapsible trigger="Execution details" defaultIsOpen={false}><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words border border-border bg-card p-3 text-secondary"><Text type="code" color="secondary">{details}</Text></pre></Collapsible></div> : null}</article>;
}

function NoticeItem({ item, label }: { item: Extract<TaskInteractionItem, { kind: "task_question" | "task_notice" }>; label: string }) {
  const detail = item.kind === "task_question" ? [item.question, item.expect ? `Expected: ${item.expect}` : null, item.answer ? `Answer: ${item.answer}` : null].filter(Boolean).join("\n\n") : item.body;
  const title = item.kind === "task_notice" && item.sender ? `${label} from ${item.sender}` : item.title || label;
  return <article className="border-l-2 border-border px-4 py-3"><ItemHeader title={title} timestamp={item.occurredAt} status={item.status} />{detail ? <Text display="block" type="supporting" color="secondary" className="mt-2 whitespace-pre-wrap break-words">{detail}</Text> : null}</article>;
}

function FileItem({ taskId, item }: { taskId: string; item: Extract<TaskInteractionItem, { kind: "file" }> }) {
  const available = item.status === "available";
  return <article className={`border-l-2 px-4 py-3 ${available ? "border-success" : "border-error bg-error-muted"}`}><div className="flex min-w-0 gap-2"><FileOutput className="mt-0.5 size-4 shrink-0 text-icon-secondary" /><div className="min-w-0"><Text display="block" type="supporting" weight="medium" className="break-words">{item.name}</Text><Text display="block" type="supporting" color={available ? "secondary" : "inherit"} className={`mt-1 ${available ? "" : "text-error"}`}>{available ? [item.mediaType, formatArtifactBytes(item.bytes)].filter(Boolean).join(" · ") : "Artifact unavailable"}</Text></div></div><TaskArtifactActions taskId={taskId} artifact={{ id: item.artifactId, name: item.name, mediaType: item.mediaType, bytes: item.bytes }} available={available} className="mt-2" />{item.body ? <Text display="block" type="supporting" color={available ? "secondary" : "inherit"} className={`mt-2 whitespace-pre-wrap break-words ${available ? "" : "text-error"}`}>{item.body}</Text> : null}</article>;
}

function SystemError({ item }: { item: Extract<TaskInteractionItem, { kind: "system_error" }> }) {
  return <Banner status="error" icon={<CircleAlert size={16} />} title={<ItemHeader title={item.title || "Task issue"} timestamp={item.occurredAt} status={item.status} />} description={<><ContentNotice contentMode={item.contentMode} detailsOmitted={item.detailsOmitted} />{item.body ? <Text display="block" type="supporting" className="mt-2 whitespace-pre-wrap break-words">{item.body}</Text> : null}<Text display="block" type="supporting" color="secondary" className="mt-2">{item.retryable ? "Retryable" : "Not retryable"}</Text></>} />;
}

function ContentNotice({ contentMode, detailsOmitted = false }: { contentMode: TaskInteractionItem["contentMode"]; detailsOmitted?: boolean }) {
  const labels = [contentMode === "preview" ? "Preview only" : contentMode === "none" ? "Content omitted" : null, detailsOmitted ? "Some details omitted" : null].filter(Boolean);
  return labels.length > 0 ? <Text display="block" type="supporting" color="secondary" className="mt-2">{labels.join(" · ")}</Text> : null;
}

function ItemHeader({ title, timestamp, status, action }: { title: string; timestamp: string | null; status: string | null; action?: ReactNode }) {
  return <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><div className="flex min-w-0 items-center gap-1"><Text type="supporting" weight="medium">{title}</Text>{action}</div><div className="flex items-center gap-2 text-secondary">{status ? <Text type="code" color="secondary">{statusLabel(status)}</Text> : null}{timestamp ? <time className="inline-flex items-center gap-1"><Clock3 size={13} /><Text type="code" color="secondary">{formatTaskDate(timestamp)}</Text></time> : null}</div></div>;
}

function statusLabel(status: string): string { const value = status.replaceAll("_", " ").toLowerCase(); return value.charAt(0).toUpperCase() + value.slice(1); }
function workTitle(item: Extract<TaskInteractionItem, { kind: "tool" | "background_task" | "task_result" | "subagent_result" }>): string { return item.kind === "tool" ? item.toolName : item.kind === "background_task" ? item.label : item.kind === "subagent_result" ? item.name : item.title; }
function workSummary(item: Extract<TaskInteractionItem, { kind: "tool" | "background_task" | "task_result" | "subagent_result" }>): string | null { return item.kind === "tool" ? item.command : item.kind === "background_task" ? item.workSummary : item.kind === "subagent_result" ? item.purpose : null; }
function workDetails(item: Extract<TaskInteractionItem, { kind: "tool" | "background_task" | "task_result" | "subagent_result" }>): string | null { if (item.kind === "tool") return [item.command, item.outputTail, item.exitCode === null ? null : `Exit code: ${item.exitCode}`].filter(Boolean).join("\n\n") || null; if (item.kind === "background_task") return [item.workSummary, item.result, item.error].filter(Boolean).join("\n\n") || null; if (item.kind === "task_result" || item.kind === "subagent_result") return [item.result, item.error].filter(Boolean).join("\n\n") || null; return null; }
function assertNever(value: never): never { throw new Error(`Unsupported task interaction: ${String(value)}`); }
