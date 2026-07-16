"use client";

import { CircleAlert, Loader2, Square } from "lucide-react";
import type { TaskCapabilities, TaskInteractionSnapshot } from "../../lib/api/client";
import { Button } from "../ui/button";

export function TaskRunStatus({ runState, capabilities, aborting, onAbort }: { runState: TaskInteractionSnapshot["runState"]; capabilities: TaskCapabilities; aborting: boolean; onAbort: () => Promise<void> }) {
  const active = runState !== "idle" && runState !== "terminal";
  return <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-low px-4 py-3 sm:px-5" role="status" aria-live="polite"><div className="flex min-w-0 items-center gap-2"><Loader2 className={`size-4 shrink-0 text-icon-default ${active ? "animate-spin" : ""}`} /><p className="text-sm text-secondary">{runStateLabel(runState)}</p></div>{capabilities.abortTurn ? <Button variant="quiet" size="sm" disabled={aborting} onClick={() => void onAbort()}><Square size={14} />{aborting ? "Stopping..." : "Stop current turn"}</Button> : null}</div>;
}

export function TaskConnectionNotice({ connection, historyStatus, runtimeReachability, error, onRetry }: { connection: "connecting" | "reconnecting" | "connected" | "disconnected" | "recovered"; historyStatus: TaskInteractionSnapshot["historyStatus"]; runtimeReachability: TaskInteractionSnapshot["runtimeReachability"]; error: string; onRetry: () => void }) {
  const showConnection = connection !== "connected" || historyStatus === "gap" || runtimeReachability === "unreachable";
  if (!showConnection) return null;
  const detail = historyStatus === "gap" ? "Some earlier interaction history is no longer available." : runtimeReachability === "unreachable" ? "The task runtime is temporarily unreachable. Saved interactions remain available." : connection === "disconnected" ? ["Conversation updates are temporarily disconnected.", error].filter(Boolean).join(" ") : connection === "recovered" ? "Conversation updates recovered." : connection === "reconnecting" ? "Reconnecting to conversation updates..." : "Connecting to conversation updates...";
  return <div className={`flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3 text-sm ${connection === "disconnected" || historyStatus === "gap" || runtimeReachability === "unreachable" ? "border-warning/30 bg-warning/10 text-foreground" : "border-border bg-surface-low text-secondary"}`} role={connection === "disconnected" || historyStatus === "gap" ? "alert" : "status"}><span className="flex items-start gap-2"><CircleAlert className="mt-0.5 size-4 shrink-0" />{detail}</span>{connection === "disconnected" || runtimeReachability === "unreachable" ? <Button variant="quiet" size="sm" onClick={onRetry}>Retry</Button> : null}</div>;
}

function runStateLabel(runState: TaskInteractionSnapshot["runState"]): string { return runState === "idle" ? "Ready for a message" : runState === "starting" ? "Starting task run" : runState === "running" ? "Working" : runState === "reconnecting" ? "Reconnecting task run" : runState === "aborting" ? "Stopping current turn" : runState === "finalizing" ? "Finalizing task run" : "Task run is complete"; }
