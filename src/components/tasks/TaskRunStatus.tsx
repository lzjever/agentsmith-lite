"use client";

import { CheckCircle2, CircleAlert, CircleDot, Loader2, Square } from "lucide-react";
import { useState } from "react";
import type { TaskCapabilities, TaskInteractionSnapshot } from "../../lib/api/client";
import { Button } from "../ui/button";

export function TaskRunStatus({ runState, capabilities, aborting, onAbort }: { runState: TaskInteractionSnapshot["runState"]; capabilities: TaskCapabilities; aborting: boolean; onAbort: () => Promise<void> }) {
  const [abortError, setAbortError] = useState("");
  const active = runState !== "idle" && runState !== "terminal";
  async function abort() {
    if (!capabilities.abortTurn || aborting) return;
    setAbortError("");
    try { await onAbort(); }
    catch (reason) { setAbortError(reason instanceof Error ? reason.message : "Current turn could not be stopped."); }
  }
  const Icon = runState === "terminal" ? CheckCircle2 : runState === "idle" ? CircleDot : Loader2;
  const iconLabel = runState === "terminal" ? "Task complete" : runState === "idle" ? "Task ready" : "Task in progress";
  return <div className="shrink-0 border-b border-border bg-surface-low px-4 py-3 sm:px-5" role="status" aria-live="polite"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><Icon role="img" aria-label={iconLabel} className={`size-4 shrink-0 ${runState === "terminal" ? "text-success" : "text-icon-default"} ${active ? "animate-spin" : ""}`} /><p className="text-sm text-secondary">{runStateLabel(runState)}</p></div>{capabilities.abortTurn ? <Button variant="quiet" size="sm" disabled={aborting} onClick={() => void abort()}><Square size={14} />{aborting ? "Stopping..." : "Stop current turn"}</Button> : null}</div>{capabilities.abortTurn && abortError ? <p className="mt-2 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{abortError}</p> : null}</div>;
}

export function TaskConnectionNotice({ connection, historyStatus, runtimeReachability, error, onRetry }: { connection: "connecting" | "reconnecting" | "connected" | "disconnected" | "recovered"; historyStatus: TaskInteractionSnapshot["historyStatus"]; runtimeReachability: TaskInteractionSnapshot["runtimeReachability"]; error: string; onRetry: () => void }) {
  const showConnection = connection !== "connected" || historyStatus === "gap" || runtimeReachability === "unreachable";
  if (!showConnection) return null;
  const detail = historyStatus === "gap" ? "Some earlier interaction history is no longer available." : runtimeReachability === "unreachable" ? "The task runtime is temporarily unreachable. Saved interactions remain available." : connection === "disconnected" ? ["Conversation updates are temporarily disconnected.", error].filter(Boolean).join(" ") : connection === "recovered" ? "Conversation updates recovered." : connection === "reconnecting" ? "Reconnecting to conversation updates..." : "Connecting to conversation updates...";
  return <div className={`flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3 text-sm ${connection === "disconnected" || historyStatus === "gap" || runtimeReachability === "unreachable" ? "border-warning/30 bg-warning/10 text-foreground" : "border-border bg-surface-low text-secondary"}`} role={connection === "disconnected" || historyStatus === "gap" ? "alert" : "status"}><span className="flex items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" />{detail}</span>{connection === "disconnected" || runtimeReachability === "unreachable" ? <Button variant="quiet" size="sm" onClick={onRetry}>Retry</Button> : null}</div>;
}

function runStateLabel(runState: TaskInteractionSnapshot["runState"]): string { return runState === "idle" ? "Ready for a message" : runState === "starting" ? "Starting task run" : runState === "running" ? "Working" : runState === "reconnecting" ? "Reconnecting task run" : runState === "aborting" ? "Stopping current turn" : runState === "finalizing" ? "Finalizing task run" : "Task run is complete"; }
