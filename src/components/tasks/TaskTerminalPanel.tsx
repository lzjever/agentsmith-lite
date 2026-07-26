"use client";

import { Maximize2, Play, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from "react";
import { Banner, Button, IconButton, Spinner, Text } from "@astryxdesign/core";
import { useTheme } from "@astryxdesign/core/theme";
import { ApiError, apiClient, newIdempotencyKey, type TaskDetail } from "../../lib/api/client";
import { xtermThemeFromTokens } from "./terminal-theme";
import { sandboxCapacityRecovery, type SandboxCapacityRecovery } from "./sandbox-capacity-recovery";
import { SandboxCapacityRecoveryNotice } from "./SandboxCapacityRecoveryNotice";
import { convergeTerminalStart, waitForTerminalStart } from "./task-terminal-start";
import type { TaskCommandFence } from "./task-conversation-state";
import {
  terminalSurfaceState,
  terminalTransportEnabled,
  type CanonicalTerminalObservation,
  type TerminalIntentAction,
  type TerminalIntentState
} from "./task-terminal-state";

type TerminalState = "connecting" | "ready" | "closed" | "error";
const AUTO_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

function formatTerminalState(value: string): string {
  const sentence = value.replaceAll("_", " ").toLowerCase();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function TaskTerminalPanel({
  taskId,
  presentation,
  canonicalEpoch,
  intent,
  activeSandboxesHref,
  canManagePolicy,
  policyHref,
  onIntent,
  captureCommandFence,
  acceptCanonicalMutation,
  requestCanonicalRefresh
}: {
  taskId: string;
  presentation: TaskDetail;
  canonicalEpoch: number;
  intent: TerminalIntentState;
  activeSandboxesHref: string;
  canManagePolicy: boolean;
  policyHref: string;
  onIntent: Dispatch<TerminalIntentAction>;
  captureCommandFence: () => TaskCommandFence;
  acceptCanonicalMutation: (
    kind: "terminal_start",
    fence: TaskCommandFence,
    options: { targetRunId: string }
  ) => unknown;
  requestCanonicalRefresh: (quiet?: boolean) => Promise<unknown>;
}) {
  const operation = useRef<AbortController | null>(null);
  const [explicitStartPending, setExplicitStartPending] = useState(false);
  const [startError, setStartError] = useState("");
  const [capacityRecovery, setCapacityRecovery] = useState<SandboxCapacityRecovery | null>(null);
  const surface = terminalSurfaceState(presentation, explicitStartPending);
  const observation: CanonicalTerminalObservation = {
    taskId,
    canonicalEpoch,
    runId: presentation.sandboxState.runId,
    sandboxState: presentation.sandboxState.state,
    openTerminal: presentation.capabilities.openTerminal
  };
  const handleAccessTerminated = useCallback(() => {
    onIntent({ type: "transport_terminated" });
  }, [onIntent]);

  useEffect(() => {
    onIntent({
      type: "canonical_observed",
      observation: {
        taskId,
        canonicalEpoch,
        runId: presentation.sandboxState.runId,
        sandboxState: presentation.sandboxState.state,
        openTerminal: presentation.capabilities.openTerminal
      }
    });
  }, [
    onIntent,
    presentation.capabilities.openTerminal,
    presentation.sandboxState.runId,
    presentation.sandboxState.state,
    canonicalEpoch,
    taskId
  ]);

  useEffect(() => () => {
    operation.current?.abort();
    operation.current = null;
  }, [taskId]);

  async function start() {
    if (surface.kind !== "start") return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const commandFence = captureCommandFence();
    const key = newIdempotencyKey("task-terminal-start");
    setExplicitStartPending(true);
    setStartError("");
    setCapacityRecovery(null);
    onIntent({ type: "start_progressed" });
    try {
      await convergeTerminalStart({
        taskId,
        idempotencyKey: key,
        signal: controller.signal,
        start: (id, idempotencyKey, signal) => apiClient.startTaskTerminal(id, idempotencyKey, signal),
        wait: waitForTerminalStart,
        onReceipt: (next) => {
          acceptCanonicalMutation("terminal_start", commandFence, {
            targetRunId: next.runId
          });
          onIntent({
            type: "start_target_recorded",
            fence: commandFence,
            targetRunId: next.runId
          });
        }
      });
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.presentation) {
        void requestCanonicalRefresh(true);
      }
      const recovery = sandboxCapacityRecovery(reason);
      setCapacityRecovery(recovery);
      if (!recovery) {
        setStartError(reason instanceof Error ? reason.message : "Sandbox could not be started");
      }
      onIntent({ type: "start_failed" });
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setExplicitStartPending(false);
      }
    }
  }

  if (terminalTransportEnabled(surface, intent)) {
    return <TerminalTransport
      taskId={taskId}
      onAccessTerminated={handleAccessTerminated}
    />;
  }

  const cleanupMessage = presentation.sandboxState.cause?.message
    ?? (presentation.sandboxState.state === "release_requested"
      ? "Sandbox cleanup is pending."
      : "The failed Sandbox must be cleaned up before Terminal can start.");
  return <section className="grid h-full min-h-0 flex-1 place-items-center border border-border bg-muted px-5" aria-label="Task terminal">
    <div className="max-w-lg text-center">
      <TerminalSquare className="mx-auto size-6 text-icon-secondary" />
      {surface.kind === "unavailable" ? <>
        <Text as="p" display="block" className="mt-3" weight="semibold">Terminal unavailable</Text>
        <Text as="p" display="block" type="supporting" color="secondary" className="mt-2">You do not have access to open Terminal for this Task.</Text>
      </> : null}
      {surface.kind === "start" ? <>
        <Text as="p" display="block" className="mt-3" weight="semibold">Terminal is stopped</Text>
        <Text as="p" display="block" type="supporting" color="secondary" className="mt-2">Start the Sandbox to continue this same Task, session, and File Library.</Text>
        <Button className="mt-4" label="Start Terminal" variant="primary" icon={<Play size={15} />} onClick={() => void start()} />
      </> : null}
      {surface.kind === "starting" ? <>
        <div className="mt-3 flex justify-center"><Spinner label="Starting Terminal..." /></div>
        <Text as="p" display="block" type="supporting" color="secondary" className="mt-2">Starting the Sandbox for this Task.</Text>
      </> : null}
      {surface.kind === "cleanup_pending" ? <>
        <Text as="p" display="block" className="mt-3" weight="semibold">Terminal cleanup pending</Text>
        <Text as="p" display="block" type="supporting" color="secondary" className="mt-2">{cleanupMessage}</Text>
      </> : null}
      {surface.kind === "active" ? <>
        <Text as="p" display="block" className="mt-3" weight="semibold">Terminal is active</Text>
        <Button className="mt-4" label="Connect Terminal" variant="primary" icon={<Play size={15} />} onClick={() => onIntent({ type: "connect_requested", observation })} />
      </> : null}
      {capacityRecovery ? <SandboxCapacityRecoveryNotice className="mt-4 text-left" recovery={capacityRecovery} activeSandboxesHref={activeSandboxesHref} canManagePolicy={canManagePolicy} policyHref={policyHref} title="Sandbox could not be started" /> : null}
      {startError && !capacityRecovery ? <Banner className="mt-4 text-left" status="error" title="Sandbox could not be started" description={startError} /> : null}
    </div>
  </section>;
}

function TerminalTransport({
  taskId,
  onAccessTerminated
}: {
  taskId: string;
  onAccessTerminated: () => void;
}) {
  const active = true;
  const { tokens } = useTheme();
  const terminalTheme = useMemo(() => xtermThemeFromTokens(tokens), [tokens]);
  const viewport = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<import("@xterm/xterm").Terminal | null>(null);
  const terminalThemeRef = useRef(terminalTheme);
  const fitInstance = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const socketInstance = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const terminalTaskId = useRef(taskId);
  const activeRef = useRef(active);
  const previousActive = useRef(active);
  const needsFit = useRef(true);
  const focusWhenVisible = useRef(active);
  const focusFrameReady = useRef(false);
  const initialReadyHandled = useRef(false);
  const [terminalEpoch, setTerminalEpoch] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<TerminalState>("connecting");
  const [error, setError] = useState("");
  terminalThemeRef.current = terminalTheme;
  if (active && !previousActive.current) {
    focusWhenVisible.current = true;
    focusFrameReady.current = false;
  }
  activeRef.current = active;

  const fitTerminal = useCallback((focus: boolean) => {
    const container = viewport.current;
    const fit = fitInstance.current;
    const terminal = terminalInstance.current;
    if (!container || !fit || !terminal || container.clientWidth === 0 || container.clientHeight === 0) {
      needsFit.current = true;
      if (focus) focusWhenVisible.current = true;
      return false;
    }
    fit.fit();
    sendSize(socketInstance.current, terminal);
    needsFit.current = false;
    if (focus) {
      terminal.focus();
      focusWhenVisible.current = false;
      focusFrameReady.current = false;
    }
    return true;
  }, []);

  useEffect(() => {
    let disposed = false;
    let initialFrame: number | undefined;
    let observer: ResizeObserver | undefined;
    let terminal: import("@xterm/xterm").Terminal | undefined;

    terminalTaskId.current = taskId;
    reconnectAttempt.current = 0;
    initialReadyHandled.current = false;
    needsFit.current = true;
    focusWhenVisible.current = activeRef.current;
    focusFrameReady.current = false;
    setError("");
    setState("connecting");

    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([xterm, addon]) => {
        const container = viewport.current;
        if (disposed || !container) return;
        terminal = new xterm.Terminal({
          cursorBlink: true,
          ...terminalTypography(container),
          scrollback: 5000,
          theme: terminalThemeRef.current,
        });
        const fit = new addon.FitAddon();
        terminal.loadAddon(fit);
        terminal.open(container);
        terminalInstance.current = terminal;
        fitInstance.current = fit;
        terminal.writeln("\x1b[90mConnecting to the task workspace...\x1b[0m");
        terminal.onData((data) => {
          const socket = socketInstance.current;
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ op: "stdin", data: encodeBase64(data) }));
          }
        });
        observer = new ResizeObserver(() => {
          if (!activeRef.current) {
            needsFit.current = true;
            return;
          }
          if (focusWhenVisible.current && !focusFrameReady.current) {
            needsFit.current = true;
            return;
          }
          fitTerminal(focusWhenVisible.current);
        });
        observer.observe(container);
        setTerminalEpoch((value) => value + 1);
        initialFrame = requestAnimationFrame(() => {
          focusFrameReady.current = true;
          if (activeRef.current) fitTerminal(true);
        });
      })
      .catch(() => {
        if (disposed) return;
        setError("Task terminal could not be loaded.");
        setState("error");
      });

    return () => {
      disposed = true;
      if (initialFrame !== undefined) cancelAnimationFrame(initialFrame);
      observer?.disconnect();
      const socket = socketInstance.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ op: "cancel" }));
      }
      socket?.close();
      if (socketInstance.current === socket) socketInstance.current = null;
      terminal?.dispose();
      terminalInstance.current = null;
      fitInstance.current = null;
    };
  }, [fitTerminal, taskId]);

  useEffect(() => {
    if (!terminalInstance.current || terminalTaskId.current !== taskId) return;
    let disposed = false;
    let retryScheduled = false;
    let shellExited = false;
    let transportTerminated = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const socket = new WebSocket(apiClient.taskTerminalWebSocketUrl(taskId));
    socketInstance.current = socket;
    setState("connecting");

    const retryOrFail = (message: string) => {
      if (disposed || retryScheduled || shellExited || transportTerminated) return;
      const delay = AUTO_RECONNECT_DELAYS_MS[reconnectAttempt.current];
      if (delay === undefined) {
        transportTerminated = true;
        setError(message);
        setState("error");
        onAccessTerminated();
        return;
      }
      retryScheduled = true;
      reconnectAttempt.current += 1;
      setState("connecting");
      terminalInstance.current?.writeln(
        `\r\n\x1b[90mTerminal disconnected. Reconnecting in ${delay / 1_000}s...\x1b[0m`,
      );
      retryTimer = setTimeout(() => {
        if (!disposed) setGeneration((value) => value + 1);
      }, delay);
    };

    socket.onmessage = (event) => {
      if (disposed) return;
      let frame: { op?: string; data?: string; message?: string; exit_code?: number | null };
      try {
        frame = JSON.parse(String(event.data)) as typeof frame;
      } catch {
        return;
      }
      const terminal = terminalInstance.current;
      if (frame.op === "ready") {
        reconnectAttempt.current = 0;
        setError("");
        setState("ready");
        if (!initialReadyHandled.current) {
          terminal?.clear();
          initialReadyHandled.current = true;
        }
        if (activeRef.current) {
          fitTerminal(false);
        } else {
          needsFit.current = true;
        }
        return;
      }
      if (frame.op === "output" && frame.data) {
        terminal?.write(decodeBase64(frame.data));
        return;
      }
      if (frame.op === "completed") {
        shellExited = true;
        terminal?.writeln(
          `\r\n\x1b[90mShell exited${
            frame.exit_code === null || frame.exit_code === undefined ? "" : ` with code ${frame.exit_code}`
          }.\x1b[0m`,
        );
        setState("closed");
        return;
      }
      if (frame.op === "error") {
        retryOrFail(frame.message ?? "Task terminal failed.");
        socket.close();
      }
    };
    socket.onerror = () => {
      if (!disposed) retryOrFail("Task terminal connection failed.");
    };
    socket.onclose = (event) => {
      if (disposed || transportTerminated) return;
      if (event.code === 1008) {
        transportTerminated = true;
        shellExited = true;
        if (retryTimer) clearTimeout(retryTimer);
        retryScheduled = false;
        setError(event.reason || "Task terminal access changed.");
        setState("error");
        onAccessTerminated();
        return;
      }
      if (shellExited) {
        setState("closed");
        return;
      }
      if (event.code === 1009) {
        if (retryTimer) clearTimeout(retryTimer);
        retryScheduled = false;
        setError(event.reason || "Task terminal connection exceeded its buffer limit.");
        setState("error");
        return;
      }
      retryOrFail("Task terminal connection failed.");
    };

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket.close();
      if (socketInstance.current === socket) socketInstance.current = null;
    };
  }, [fitTerminal, generation, onAccessTerminated, taskId, terminalEpoch]);

  useEffect(() => {
    const updateAppearance = () => {
      const terminal = terminalInstance.current;
      const container = viewport.current;
      if (!terminal || !container) return;
      terminal.options.theme = terminalTheme;
      const typography = terminalTypography(container);
      terminal.options.fontFamily = typography.fontFamily;
      terminal.options.fontSize = typography.fontSize;
      if (activeRef.current) {
        fitTerminal(false);
      } else {
        needsFit.current = true;
      }
    };
    updateAppearance();
    document.fonts?.addEventListener("loadingdone", updateAppearance);
    return () => document.fonts?.removeEventListener("loadingdone", updateAppearance);
  }, [fitTerminal, terminalTheme]);

  useEffect(() => {
    const wasActive = previousActive.current;
    previousActive.current = active;
    if (!active) {
      needsFit.current = true;
      focusWhenVisible.current = false;
      focusFrameReady.current = false;
      return;
    }
    if (wasActive) return;
    focusWhenVisible.current = true;
    focusFrameReady.current = false;
    const frame = requestAnimationFrame(() => {
      focusFrameReady.current = true;
      fitTerminal(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, fitTerminal]);

  return <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-muted" aria-label="Task terminal">
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border bg-card px-3 text-primary"><div className="flex items-center gap-2"><TerminalSquare size={16}/><Text type="supporting">Task terminal</Text><Text type="code" color="secondary">{formatTerminalState(state)}</Text></div><IconButton label="Fit terminal" tooltip="Fit terminal" variant="ghost" icon={<Maximize2 size={15}/>} onClick={() => { focusFrameReady.current = true; fitTerminal(true); }}/></div>
    {error?<Banner status="error" container="section" title="Terminal connection failed" description={error}/>:null}
    <div ref={viewport} className="min-h-0 w-full flex-1 p-2" style={{ fontFamily: "var(--font-family-code)", fontSize: "var(--font-size-sm)" }} />
  </section>;
}

function terminalTypography(container:HTMLElement):{fontFamily:string;fontSize:number}{
  const computed=window.getComputedStyle(container);
  const fontSize=Number.parseFloat(computed.fontSize);
  if(!Number.isFinite(fontSize))throw new Error("Task terminal font size is unavailable.");
  return {fontFamily:computed.fontFamily,fontSize};
}

function decodeBase64(value:string):string{
  const raw=atob(value);const bytes=Uint8Array.from(raw,(character)=>character.charCodeAt(0));return new TextDecoder().decode(bytes);
}
function encodeBase64(value:string):string{
  const bytes=new TextEncoder().encode(value);let raw="";for(const byte of bytes)raw+=String.fromCharCode(byte);return btoa(raw);
}

function sendSize(socket:WebSocket|null|undefined,terminal:import("@xterm/xterm").Terminal|null|undefined):void{
  if(socket?.readyState===WebSocket.OPEN&&terminal)socket.send(JSON.stringify({op:"resize",rows:terminal.rows,cols:terminal.cols}));
}
