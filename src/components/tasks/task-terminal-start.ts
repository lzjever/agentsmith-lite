import type { TaskTerminalStartReceipt } from "../../lib/api/client.js";

const TERMINAL_START_DELAYS_MS = [400, 600, 800, 1_000, 1_200, 1_500, 2_000] as const;

export type TerminalStartConvergenceOptions = {
  taskId: string;
  idempotencyKey: string;
  signal: AbortSignal;
  start: (
    taskId: string,
    idempotencyKey: string,
    signal: AbortSignal
  ) => Promise<TaskTerminalStartReceipt>;
  wait: (delay: number, signal: AbortSignal) => Promise<void>;
  onReceipt: (receipt: TaskTerminalStartReceipt) => void;
};

export async function convergeTerminalStart(
  options: TerminalStartConvergenceOptions
): Promise<Extract<TaskTerminalStartReceipt, { status: "active" }>> {
  let attempt = 0;
  while (true) {
    throwIfAborted(options.signal);
    const receipt = await options.start(
      options.taskId,
      options.idempotencyKey,
      options.signal
    );
    throwIfAborted(options.signal);
    options.onReceipt(receipt);
    if (receipt.status === "active") return receipt;
    await options.wait(terminalStartPollDelay(attempt), options.signal);
    attempt += 1;
  }
}

export function terminalStartPollDelay(attempt: number): number {
  return TERMINAL_START_DELAYS_MS[Math.min(
    Math.max(0, attempt),
    TERMINAL_START_DELAYS_MS.length - 1
  )]!;
}

export function waitForTerminalStart(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(done, delay);
    signal.addEventListener("abort", aborted, { once: true });
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(abortError());
    }
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException("Terminal start was aborted", "AbortError");
}
