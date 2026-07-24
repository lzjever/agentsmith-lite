"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bell, Check, RotateCcw, Trash2 } from "lucide-react";
import { Banner, Button, EmptyState, IconButton, Text } from "@astryxdesign/core";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { apiClient, isMissingNotification, NOTIFICATIONS_CHANGED_EVENT, notificationChangeSource, notifyNotificationsChanged, type UserNotification } from "../../lib/api/client";
import { formatLocalDateTime } from "../../lib/format/date";
import { workspaceReturnPath } from "../../lib/navigation/return-path";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";

export function NotificationsPage() {
  const router = useRouter();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const [items, setItems] = useState<UserNotification[]>([]); const [state, setState] = useState<"loading" | "ready" | "error">("loading"); const [mutationError, setMutationError] = useState<{ id: string; action: "read" | "dismiss"; message: string } | null>(null); const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setState("loading");
    try {
      const listed = await apiClient.notifications();
      if (!mounted.current || request !== loadRequest.current) return;
      setItems(listed);
      setState("ready");
    } catch {
      if (mounted.current && request === loadRequest.current) setState("error");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void load();
    const changed = (event: Event) => {
      if (notificationChangeSource(event) !== "page") void load();
    };
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, changed);
  }, [load]);
  function setBusy(id: string, busy: boolean) {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  async function read(id: string) {
    if (busyIds.has(id)) return false;
    setBusy(id, true);
    setMutationError(null);
    try {
      const saved = await apiClient.markNotificationRead(id);
      if (!mounted.current) return false;
      notifyNotificationsChanged("page");
      loadRequest.current += 1;
      setItems((current) => current.map((item) => item.id === id ? saved : item));
      setState("ready");
      return true;
    } catch (reason) {
      if (!mounted.current) return false;
      if (isMissingNotification(reason)) {
        loadRequest.current += 1;
        setItems((current) => current.filter((item) => item.id !== id));
        setState("ready");
        notifyNotificationsChanged("page");
        return true;
      }
      setMutationError({ id, action: "read", message: "Notification could not be marked as read." });
      return false;
    } finally {
      if (mounted.current) setBusy(id, false);
    }
  }
  async function dismiss(id: string) {
    if (busyIds.has(id)) return;
    setBusy(id, true);
    setMutationError(null);
    try {
      await apiClient.dismissNotification(id);
      if (!mounted.current) return;
      notifyNotificationsChanged("page");
      loadRequest.current += 1;
      setItems((current) => current.filter((item) => item.id !== id));
      setState("ready");
    } catch (reason) {
      if (!mounted.current) return;
      if (isMissingNotification(reason)) {
        loadRequest.current += 1;
        setItems((current) => current.filter((item) => item.id !== id));
        setState("ready");
        notifyNotificationsChanged("page");
        return;
      }
      setMutationError({ id, action: "dismiss", message: "Notification could not be dismissed." });
    } finally {
      if (mounted.current) setBusy(id, false);
    }
  }
  async function openLinked(event: MouseEvent<HTMLAnchorElement>, item: UserNotification) {
    event.preventDefault();
    if ((item.readAt || await read(item.id)) && mounted.current) router.push(item.linkPath!);
  }
  const returnTo = notificationReturnPath();
  return <PageLayout contentWidth="narrow" header={<PageHeader title="Notifications" subtitle="Project activity that needs your attention." actions={returnTo !== "/" ? <Link href={returnTo} className="inline-flex items-center gap-2 hover:text-primary"><ArrowLeft size={16} /><Text type="supporting" color="secondary">{returnTo.includes("/projects/") ? "Back to project" : "Back to workspace"}</Text></Link> : undefined} />}>{state === "loading" ? <div className="grid min-h-64 place-items-center" role="status"><Text color="secondary">Loading notifications...</Text></div> : null}{state === "error" ? <Banner status="error" title="Notifications unavailable" description="Notifications could not be loaded." endContent={<Button label="Try again" variant="ghost" onClick={() => void load()} />} /> : null}{state === "ready" && items.length === 0 ? <EmptyState icon={<Bell />} title="No notifications" /> : null}{state === "ready" && items.length > 0 ? <ul className="divide-y divide-border border-y border-border">{items.map((item) => <li key={item.id} className="py-4"><div className="flex gap-3"><Bell className="mt-0.5 size-4 shrink-0 text-icon-secondary" /><div className="min-w-0 flex-1"><Text color={item.readAt ? "secondary" : "primary"} weight={item.readAt ? "normal" : "semibold"} display="block">{item.linkPath ? <Link href={item.linkPath} onClick={(event) => void openLinked(event, item)}>{item.title}</Link> : item.title}</Text>{item.body ? <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">{item.body}</Text> : null}<Text as="p" type="supporting" color="secondary" display="block" className="mt-1">{formatLocalDateTime(item.createdAt)}</Text></div><div className="flex gap-1">{!item.readAt ? <IconButton label="Mark notification read" variant="ghost" icon={<Check size={16} />} isDisabled={busyIds.has(item.id)} onClick={() => void read(item.id)} /> : null}<IconButton label="Dismiss notification" variant="ghost" icon={<Trash2 size={16} />} isDisabled={busyIds.has(item.id)} onClick={() => void dismiss(item.id)} /></div></div>{mutationError?.id === item.id ? <Banner className="mt-3" status="error" title={mutationError.action === "read" ? "Notification could not be marked as read" : "Notification could not be dismissed"} description={mutationError.message} endContent={<Button label="Retry" variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={() => void (mutationError.action === "read" ? read(item.id) : dismiss(item.id))} />} /> : null}</li>)}</ul> : null}</PageLayout>;
}
function notificationReturnPath(): string { const value = new URLSearchParams(window.location.search).get("returnTo"); return workspaceReturnPath(value, window.location.pathname, "/notifications"); }
