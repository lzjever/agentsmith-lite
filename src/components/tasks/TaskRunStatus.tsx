"use client";

import { CircleAlert, CircleCheck, CircleDot, Loader2, Square } from "lucide-react";
import { useState } from "react";
import type { TaskCapabilities, TaskDetail, TaskInteractionSnapshot } from "../../lib/api/client";
import { Button } from "../ui/button";

export function TaskRunStatus({ currentTurn, sandboxState, capabilities, aborting, onAbort }: { currentTurn: TaskDetail["currentTurn"]; sandboxState: TaskDetail["sandboxState"]; capabilities: TaskCapabilities; aborting: boolean; onAbort: () => Promise<void> }) {
  const [abortError, setAbortError] = useState("");
  async function abort() {
    if (!capabilities.abortTurn || aborting) return;
    setAbortError("");
    try { await onAbort(); }
    catch (reason) { setAbortError(reason instanceof Error ? reason.message : "Current turn could not be stopped."); }
  }
  const presentation = runStatePresentation(currentTurn, sandboxState);
  const Icon = presentation.icon;
  return <div className="shrink-0 border-b border-border bg-surface-low px-4 py-3 sm:px-5" role="status" aria-live="polite"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><Icon role="img" aria-label={presentation.iconLabel} className={`size-4 shrink-0 ${presentation.iconClass} ${presentation.spinning ? "animate-spin" : ""}`} /><p className="text-sm text-secondary">{presentation.label}</p></div>{capabilities.abortTurn ? <Button variant="quiet" size="sm" disabled={aborting} onClick={() => void abort()}><Square size={14} />{aborting ? "Stopping..." : "Stop current turn"}</Button> : null}</div>{capabilities.abortTurn && abortError ? <p className="mt-2 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{abortError}</p> : null}</div>;
}

export function TaskConnectionNotice({ connection, historyStatus, runtimeReachability, runtimeAvailable = true, error, onRetry }: { connection: "connecting" | "reconnecting" | "connected" | "disconnected" | "recovered"; historyStatus: TaskInteractionSnapshot["historyStatus"]; runtimeReachability: TaskInteractionSnapshot["runtimeReachability"]; runtimeAvailable?: boolean; error: string; onRetry: () => void }) {
  if (!runtimeAvailable && historyStatus !== "gap") return null;
  if (!runtimeAvailable) connection = "connected";
  if (!runtimeAvailable) runtimeReachability = "reachable";
  const showConnection = connection !== "connected" || historyStatus === "gap" || runtimeReachability === "unreachable";
  if (!showConnection) return null;
  const detail = historyStatus === "gap" ? "Some earlier interaction history is no longer available." : runtimeReachability === "unreachable" ? "The task runtime is temporarily unreachable. Saved interactions remain available." : connection === "disconnected" ? ["Conversation updates are temporarily disconnected.", error].filter(Boolean).join(" ") : connection === "recovered" ? "Conversation updates recovered." : connection === "reconnecting" ? "Reconnecting to conversation updates..." : "Connecting to conversation updates...";
  return <div className={`flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3 text-sm ${connection === "disconnected" || historyStatus === "gap" || runtimeReachability === "unreachable" ? "border-warning/30 bg-warning/10 text-foreground" : "border-border bg-surface-low text-secondary"}`} role={connection === "disconnected" || historyStatus === "gap" ? "alert" : "status"}><span className="flex items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" />{detail}</span>{connection === "disconnected" || runtimeReachability === "unreachable" ? <Button variant="quiet" size="sm" onClick={onRetry}>Retry</Button> : null}</div>;
}

export function TaskPreviewNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-surface-low px-4 py-3 text-sm text-secondary" role="status"><span className="flex items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" />{message}</span><Button variant="quiet" size="sm" onClick={onRetry}>Retry preview</Button></div>;
}

function runStatePresentation(currentTurn: TaskDetail["currentTurn"], sandboxState: TaskDetail["sandboxState"]) {
  if (sandboxState.state === "released") return { icon:CircleCheck, iconLabel:"Sandbox released", iconClass:"text-icon-default", label:"Sandbox released", spinning:false };
  if (sandboxState.state === "failed") return { icon:CircleAlert, iconLabel:"Sandbox unavailable", iconClass:"text-error", label:"Sandbox is unavailable", spinning:false };
  if (sandboxState.state === "release_requested") return { icon:Loader2, iconLabel:"Sandbox release requested", iconClass:"text-icon-default", label:"Releasing sandbox", spinning:true };
  if (sandboxState.state === "starting") return { icon:Loader2, iconLabel:"Sandbox starting", iconClass:"text-icon-default", label:"Starting sandbox", spinning:true };
  if (currentTurn.state === "ready") return { icon:CircleDot, iconLabel:"Task ready", iconClass:"text-icon-default", label:"Ready for a message", spinning:false };
  if (currentTurn.state === "queued") return { icon:CircleDot, iconLabel:"Message queued", iconClass:"text-icon-default", label:"Message queued", spinning:false };
  if (currentTurn.state === "starting") return { icon:Loader2, iconLabel:"Task in progress", iconClass:"text-icon-default", label:"Starting current turn", spinning:true };
  if (currentTurn.state === "running") return { icon:Loader2, iconLabel:"Task in progress", iconClass:"text-icon-default", label:"Working", spinning:true };
  return { icon:Loader2, iconLabel:"Task in progress", iconClass:"text-icon-default", label:"Stopping current turn", spinning:true };
}
