"use client";

import Link from "next/link";
import { ArrowLeft, Bell, Check, RotateCcw, Trash2 } from "lucide-react";
import { Banner, Button, EmptyState, IconButton, Text } from "@astryxdesign/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient, isMissingNotification, NOTIFICATIONS_CHANGED_EVENT, notificationChangeSource, notifyNotificationsChanged, type UserNotification } from "../../lib/api/client";
import { formatLocalDateTime } from "../../lib/format/date";
import { workspaceReturnPath } from "../../lib/navigation/return-path";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { NotificationListCoordinator, shouldActivateLinkedNotification } from "./notification-list-state";

export function NotificationsPage() {
  const mounted = useRef(true);
  const loadedOnce = useRef(false);
  const coordinator = useRef(new NotificationListCoordinator<UserNotification>());
  const [items, setItems] = useState<UserNotification[]>([]); const [state, setState] = useState<"loading" | "ready" | "error">("loading"); const [mutationError, setMutationError] = useState<{ id: string; action: "read" | "dismiss"; message: string } | null>(null); const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [refreshError, setRefreshError] = useState("");
  const load = useCallback(async () => {
    const request = coordinator.current.beginLoad();
    if (!loadedOnce.current) setState("loading");
    setRefreshError("");
    try {
      const listed = await apiClient.notifications();
      if (!mounted.current || !coordinator.current.isCurrentLoad(request)) return;
      loadedOnce.current = true;
      setItems(coordinator.current.replace(listed));
      setState("ready");
    } catch {
      if (!mounted.current || !coordinator.current.isCurrentLoad(request)) return;
      if (loadedOnce.current) setRefreshError("Notifications could not be refreshed.");
      else setState("error");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      coordinator.current.invalidateLoads();
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
    if (busyIds.has(id) || !coordinator.current.beginItemMutation(id)) return false;
    setBusy(id, true);
    setMutationError(null);
    try {
      const saved = await apiClient.markNotificationRead(id);
      if (!mounted.current) return false;
      notifyNotificationsChanged("page");
      setItems(coordinator.current.merge(saved));
      setState("ready");
      return true;
    } catch (reason) {
      if (!mounted.current) return false;
      if (isMissingNotification(reason)) {
        setItems(coordinator.current.remove(id));
        setState("ready");
        notifyNotificationsChanged("page");
        return true;
      }
      setMutationError({ id, action: "read", message: "Notification could not be marked as read." });
      return false;
    } finally {
      coordinator.current.endItemMutation(id);
      if (mounted.current) setBusy(id, false);
    }
  }
  async function dismiss(id: string) {
    if (busyIds.has(id) || !coordinator.current.beginItemMutation(id)) return;
    setBusy(id, true);
    setMutationError(null);
    try {
      await apiClient.dismissNotification(id);
      if (!mounted.current) return;
      notifyNotificationsChanged("page");
      setItems(coordinator.current.remove(id));
      setState("ready");
    } catch (reason) {
      if (!mounted.current) return;
      if (isMissingNotification(reason)) {
        setItems(coordinator.current.remove(id));
        setState("ready");
        notifyNotificationsChanged("page");
        return;
      }
      setMutationError({ id, action: "dismiss", message: "Notification could not be dismissed." });
    } finally {
      coordinator.current.endItemMutation(id);
      if (mounted.current) setBusy(id, false);
    }
  }
  function activateLinked(item: UserNotification) {
    if (item.readAt || !coordinator.current.beginItemMutation(item.id)) return;
    setBusy(item.id, true);
    setMutationError(null);
    void apiClient.markLinkedNotificationRead(item.id).then((saved) => {
      notifyNotificationsChanged("page");
      if (!mounted.current) return;
      setItems(coordinator.current.merge(saved));
    }).catch((reason: unknown) => {
      if (isMissingNotification(reason)) {
        notifyNotificationsChanged("page");
        if (!mounted.current) return;
        setItems(coordinator.current.remove(item.id));
      } else if (mounted.current) {
        setMutationError({ id: item.id, action: "read", message: "Notification could not be marked as read." });
      }
    }).finally(() => {
      coordinator.current.endItemMutation(item.id);
      if (mounted.current) setBusy(item.id, false);
    });
  }
  function openLinked(eventType: "click" | "auxclick", button: number, item: UserNotification) {
    if (shouldActivateLinkedNotification(eventType, button)) activateLinked(item);
  }
  const returnTo = notificationReturnPath();
  return <PageLayout contentWidth="narrow" header={<PageHeader title="Notifications" subtitle="Project activity that needs your attention." actions={returnTo !== "/" ? <Link href={returnTo} className="inline-flex items-center gap-2 hover:text-primary"><ArrowLeft size={16} /><Text type="supporting" color="secondary">{returnTo.includes("/projects/") ? "Back to project" : "Back to workspace"}</Text></Link> : undefined} />}>{state === "loading" ? <div className="grid min-h-64 place-items-center" role="status"><Text color="secondary">Loading notifications...</Text></div> : null}{state === "error" ? <Banner status="error" title="Notifications unavailable" description="Notifications could not be loaded." endContent={<Button label="Try again" variant="ghost" onClick={() => void load()} />} /> : null}{state === "ready" && refreshError ? <Banner className="mb-4" status="error" title="Notifications could not be refreshed" description={refreshError} endContent={<Button label="Try again" variant="ghost" onClick={() => void load()} />} /> : null}{state === "ready" && items.length === 0 ? <EmptyState icon={<Bell />} title="No notifications" /> : null}{state === "ready" && items.length > 0 ? <ul className="divide-y divide-border border-y border-border">{items.map((item) => <li key={item.id} className="py-4"><div className="flex gap-3"><Bell className="mt-0.5 size-4 shrink-0 text-icon-secondary" /><div className="min-w-0 flex-1"><Text color={item.readAt ? "secondary" : "primary"} weight={item.readAt ? "normal" : "semibold"} display="block">{item.linkPath ? <Link href={item.linkPath} onClick={(event) => openLinked("click", event.button, item)} onAuxClick={(event) => openLinked("auxclick", event.button, item)}>{item.title}</Link> : item.title}</Text>{item.body ? <Text as="p" type="supporting" color="secondary" display="block" className="mt-1">{item.body}</Text> : null}<Text as="p" type="supporting" color="secondary" display="block" className="mt-1">{formatLocalDateTime(item.createdAt)}</Text></div><div className="flex gap-1">{!item.readAt ? <IconButton label="Mark notification read" variant="ghost" icon={<Check size={16} />} isDisabled={busyIds.has(item.id)} onClick={() => void read(item.id)} /> : null}<IconButton label="Dismiss notification" variant="ghost" icon={<Trash2 size={16} />} isDisabled={busyIds.has(item.id)} onClick={() => void dismiss(item.id)} /></div></div>{mutationError?.id === item.id ? <Banner className="mt-3" status="error" title={mutationError.action === "read" ? "Notification could not be marked as read" : "Notification could not be dismissed"} description={mutationError.message} endContent={<Button label="Retry" variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={() => void (mutationError.action === "read" ? read(item.id) : dismiss(item.id))} />} /> : null}</li>)}</ul> : null}</PageLayout>;
}
function notificationReturnPath(): string { const value = new URLSearchParams(window.location.search).get("returnTo"); return workspaceReturnPath(value, window.location.pathname, "/notifications"); }
