"use client";

import Link from "next/link";
import { Bell, Check, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { apiClient, type UserNotification } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";

export function NotificationsPage() {
  const [items, setItems] = useState<UserNotification[]>([]); const [state, setState] = useState<"loading" | "ready" | "error">("loading"); const [mutationError, setMutationError] = useState<{ id: string; action: "read" | "dismiss"; message: string } | null>(null); const [busyId, setBusyId] = useState<string | null>(null);
  const load = useCallback(async () => { setState("loading"); try { setItems(await apiClient.notifications()); setState("ready"); } catch { setState("error"); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function read(id: string) { setBusyId(id); setMutationError(null); try { const saved = await apiClient.markNotificationRead(id); setItems((current) => current.map((item) => item.id === id ? saved : item)); } catch { setMutationError({ id, action: "read", message: "Notification could not be marked as read." }); } finally { setBusyId(null); } }
  async function dismiss(id: string) { setBusyId(id); setMutationError(null); try { await apiClient.dismissNotification(id); setItems((current) => current.filter((item) => item.id !== id)); } catch { setMutationError({ id, action: "dismiss", message: "Notification could not be dismissed." }); } finally { setBusyId(null); } }
  return <PageLayout contentWidth="narrow" header={<PageHeader title="Notifications" subtitle="Project activity that needs your attention." />}>{state === "loading" ? <PageState state="loading">Loading notifications...</PageState> : null}{state === "error" ? <PageState state="error"><Button onClick={() => void load()}>Try again</Button></PageState> : null}{state === "ready" && items.length === 0 ? <PageState state="empty"><div><Bell className="mx-auto size-7 text-tertiary" /><h2 className="mt-3 type-title">No notifications</h2></div></PageState> : null}{state === "ready" && items.length > 0 ? <ul className="divide-y divide-subtle border-y border-subtle">{items.map((item) => <li key={item.id} className="py-4"><div className="flex gap-3"><Bell className="mt-0.5 size-4 shrink-0 text-icon-default" /><div className="min-w-0 flex-1"><p className={item.readAt ? "text-sm text-secondary" : "text-sm font-medium text-foreground"}>{item.linkPath ? <Link href={item.linkPath} onClick={() => !item.readAt && void read(item.id)}>{item.title}</Link> : item.title}</p>{item.body ? <p className="mt-1 text-sm text-secondary">{item.body}</p> : null}<p className="mt-1 text-xs text-tertiary">{new Date(item.createdAt).toLocaleString("en-US")}</p></div><div className="flex gap-1">{!item.readAt ? <Button variant="quiet" size="icon" aria-label="Mark notification read" disabled={busyId === item.id} onClick={() => void read(item.id)}><Check size={16} /></Button> : null}<Button variant="quiet" size="icon" aria-label="Dismiss notification" disabled={busyId === item.id} onClick={() => void dismiss(item.id)}><Trash2 size={16} /></Button></div></div>{mutationError?.id === item.id ? <div className="mt-3 flex items-center justify-between gap-3 rounded-sm border border-error/30 bg-error/10 px-3 py-2" role="alert"><span className="text-sm text-error">{mutationError.message}</span><Button variant="quiet" size="sm" onClick={() => void (mutationError.action === "read" ? read(item.id) : dismiss(item.id))}><RotateCcw size={14} />Retry</Button></div> : null}</li>)}</ul> : null}</PageLayout>;
}
