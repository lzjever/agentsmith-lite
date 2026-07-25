"use client";

import { CircleAlert, CircleDot, Loader2, Square } from "lucide-react";
import { Banner, Button as AstryxButton, Spinner, Text } from "@astryxdesign/core";
import { useState } from "react";
import type { TaskCapabilities, TaskDetail, TaskInteractionSnapshot } from "../../lib/api/client";

export function TaskRunStatus({ currentTurn, sandboxState, capabilities, aborting, onAbort }: { currentTurn: TaskDetail["currentTurn"]; sandboxState: TaskDetail["sandboxState"]; capabilities: TaskCapabilities; aborting: boolean; onAbort: () => Promise<void> }) {
  const [abortError, setAbortError] = useState("");
  async function abort() {
    if (!capabilities.abortTurn || aborting) return;
    setAbortError("");
    try { await onAbort(); }
    catch (reason) { setAbortError(reason instanceof Error ? reason.message : "Current turn could not be stopped."); }
  }
  const presentation = taskStatePresentation(currentTurn, sandboxState);
  const Icon = presentation.icon;
  return <div className="shrink-0 border-b border-border bg-muted px-4 py-3 sm:px-5" role="status" aria-live="polite"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2">{presentation.spinning ? <Spinner size="sm" label={presentation.iconLabel} /> : <Icon role="img" aria-label={presentation.iconLabel} className={`size-4 shrink-0 ${presentation.iconClass}`} />}<Text type="supporting" color="secondary">{presentation.label}</Text></div>{capabilities.abortTurn ? <AstryxButton label={aborting ? "Stopping..." : "Stop current turn"} variant="ghost" size="sm" icon={<Square size={14} />} isDisabled={aborting} isLoading={aborting} onClick={() => void abort()} /> : null}</div>{capabilities.abortTurn && abortError ? <Banner className="mt-2" status="error" title="Current turn could not be stopped" description={abortError} /> : null}</div>;
}

export function TaskConnectionNotice({ connection, historyStatus, runtimeReachability, runtimeAvailable = true, error, onRetry }: { connection: "connecting" | "reconnecting" | "connected" | "disconnected" | "recovered"; historyStatus: TaskInteractionSnapshot["historyStatus"]; runtimeReachability: TaskInteractionSnapshot["runtimeReachability"]; runtimeAvailable?: boolean; error: string; onRetry: () => void }) {
  if (!runtimeAvailable && historyStatus !== "gap") return null;
  if (!runtimeAvailable) connection = "connected";
  if (!runtimeAvailable) runtimeReachability = "reachable";
  const showConnection = connection !== "connected" || historyStatus === "gap" || runtimeReachability === "unreachable";
  if (!showConnection) return null;
  const detail = historyStatus === "gap" ? "Some earlier interaction history is no longer available." : runtimeReachability === "unreachable" ? "The task runtime is temporarily unreachable. Saved interactions remain available." : connection === "disconnected" ? ["Conversation updates are temporarily disconnected.", error].filter(Boolean).join(" ") : connection === "recovered" ? "Conversation updates recovered." : connection === "reconnecting" ? "Reconnecting to conversation updates..." : "Connecting to conversation updates...";
  const interrupted = connection === "disconnected" || historyStatus === "gap" || runtimeReachability === "unreachable";
  return <div className={`flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3 ${interrupted ? "border-warning bg-warning-muted text-primary" : "border-border bg-muted text-secondary"}`} role={connection === "disconnected" || historyStatus === "gap" ? "alert" : "status"}><Text as="span" type="supporting" color="inherit" className="flex items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" />{detail}</Text>{connection === "disconnected" || runtimeReachability === "unreachable" ? <AstryxButton label="Retry" variant="ghost" size="sm" onClick={onRetry} /> : null}</div>;
}

export function TaskPreviewNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-muted px-4 py-3 text-secondary" role="status"><Text as="span" type="supporting" color="inherit" className="flex items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" />{message}</Text><AstryxButton label="Retry preview" variant="ghost" size="sm" onClick={onRetry} /></div>;
}

function taskStatePresentation(currentTurn: TaskDetail["currentTurn"], sandboxState: TaskDetail["sandboxState"]) {
  if (sandboxState.state === "released") return { icon:CircleDot, iconLabel:"Sandbox stopped", iconClass:"text-icon-secondary", label:"Sandbox stopped. Send a message or explicitly start Terminal to continue this same Task, session, and File Library.", spinning:false };
  if (sandboxState.state === "failed") return { icon:CircleAlert, iconLabel:"Sandbox unavailable", iconClass:"text-error", label:sandboxState.cause?.message??"Sandbox is unavailable", spinning:false };
  if (sandboxState.state === "release_requested") return { icon:Loader2, iconLabel:"Sandbox release requested", iconClass:"text-icon-secondary", label:"Releasing sandbox", spinning:true };
  if (sandboxState.state === "starting") return { icon:Loader2, iconLabel:"Sandbox starting", iconClass:"text-icon-secondary", label:"Starting sandbox", spinning:true };
  if (currentTurn.state === "ready") return { icon:CircleDot, iconLabel:"Task ready", iconClass:"text-icon-secondary", label:"Ready for a message", spinning:false };
  if (currentTurn.state === "queued") return { icon:CircleDot, iconLabel:"Message queued", iconClass:"text-icon-secondary", label:"Message queued", spinning:false };
  if (currentTurn.state === "starting") return { icon:Loader2, iconLabel:"Task in progress", iconClass:"text-icon-secondary", label:"Starting current turn", spinning:true };
  if (currentTurn.state === "running") return { icon:Loader2, iconLabel:"Task in progress", iconClass:"text-icon-secondary", label:"Working", spinning:true };
  return { icon:Loader2, iconLabel:"Task in progress", iconClass:"text-icon-secondary", label:"Stopping current turn", spinning:true };
}
