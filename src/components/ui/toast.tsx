"use client";

import { AlertCircle, CheckCircle, Info, X, XCircle } from "lucide-react";
import { IconButton } from "@astryxdesign/core";
import { useSyncExternalStore } from "react";
import { appendToast, type ToastMessage, type ToastType } from "./toast-policy";

export type { ToastMessage, ToastType } from "./toast-policy";

let messages: ToastMessage[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const snapshot = () => messages;
const serverSnapshot = () => [] as ToastMessage[];

function add(type: ToastType, message: string, duration = 5_000) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  if (type === "success") {
    for (const item of messages) {
      if (item.type === "success") clearTimer(item.id);
    }
  }
  messages = appendToast(messages, { id, type, message, duration });
  notify();
  timers.set(id, setTimeout(() => remove(id), duration));
}

function clearTimer(id: string) { const timer = timers.get(id); if (timer) clearTimeout(timer); timers.delete(id); }
export function remove(id: string) { clearTimer(id); messages = messages.filter((item) => item.id !== id); notify(); }
export const toast = { success: (message: string, duration?: number) => add("success", message, duration), error: (message: string, duration?: number) => add("error", message, duration), warning: (message: string, duration?: number) => add("warning", message, duration), info: (message: string, duration?: number) => add("info", message, duration) };

export function ToastContainer() {
  const items = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const icons = { success: CheckCircle, error: XCircle, warning: AlertCircle, info: Info };
  const tones = { success: "border-l-success/70 text-success", error: "border-l-error/70 text-error", warning: "border-l-warning/70 text-warning", info: "border-l-accent/70 text-accent" };
  if (items.length === 0) return null;
  return <div className="fixed bottom-4 right-4 z-[70] flex w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] flex-col gap-2 sm:max-w-sm" aria-live="polite" aria-label="Notifications">{items.map((item) => { const Icon = icons[item.type]; return <div key={item.id} className={`flex items-start gap-3 rounded-md border border-subtle border-l-2 bg-surface-high p-4 shadow-float ${tones[item.type]}`} role={item.type === "error" ? "alert" : "status"}><Icon className="mt-0.5 size-5 shrink-0" /><p className="flex-1 text-sm text-primary">{item.message}</p><IconButton label="Dismiss notification" variant="ghost" size="sm" icon={<X size={16} />} className="shrink-0" onClick={() => remove(item.id)} /></div>; })}</div>;
}
