"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { apiClient, NOTIFICATIONS_CHANGED_EVENT, notificationChangeSource, notifyNotificationsChanged, type UserNotification } from "../../lib/api/client";
import { Button } from "../ui/button";
import { DropdownContent, DropdownMenu } from "../ui/dropdown-menu";

export function NotificationBell({ returnTo }: { returnTo?: string }) {
  const router = useRouter();
  const [items, setItems] = useState<UserNotification[]>([]); const [open, setOpen] = useState(false); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [markingAll, setMarkingAll] = useState(false);
  const mounted = useRef(true);
  const actionInFlight = useRef(false);
  const loadRevision = useRef(0);
  const load = useCallback(async () => {
    const revision = ++loadRevision.current;
    setLoading(true);
    setError("");
    try {
      const listed = await apiClient.notifications();
      if (!mounted.current || revision !== loadRevision.current) return;
      setItems(listed);
    } catch {
      if (!mounted.current || revision !== loadRevision.current) return;
      setError("Notifications could not be loaded.");
    } finally {
      if (mounted.current && revision === loadRevision.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const revision = ++loadRevision.current;
    void apiClient.notifications(true).then((listed) => {
      if (mounted.current && revision === loadRevision.current) setItems(listed);
    }).catch(() => undefined);
    const changed = (event: Event) => {
      if (notificationChangeSource(event) !== "bell") void load();
    };
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, changed);
    return () => {
      mounted.current = false;
      if (revision === loadRevision.current) loadRevision.current += 1;
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, changed);
    };
  }, [load]);
  function onOpenChange(nextOpen: boolean) { setOpen(nextOpen); if (nextOpen) void load(); }
  const unread = items.filter((item) => !item.readAt);
  async function markAllRead() {
    if (unread.length === 0 || actionInFlight.current) return;
    actionInFlight.current = true;
    loadRevision.current += 1;
    setLoading(false);
    setMarkingAll(true);
    setError("");
    try {
      const saved = await apiClient.markAllNotificationsRead();
      if (!mounted.current) return;
      setItems(saved);
      notifyNotificationsChanged("bell");
    } catch {
      if (mounted.current) setError("Notifications could not be marked as read. Try again.");
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setMarkingAll(false);
    }
  }
  async function openItem(item: UserNotification) {
    if (actionInFlight.current) return false;
    actionInFlight.current = true;
    loadRevision.current += 1;
    setLoading(false);
    try {
      if (!item.readAt) {
        try {
          const saved = await apiClient.markNotificationRead(item.id);
          if (!mounted.current) return false;
          setItems((current) => current.map((value) => value.id === saved.id ? saved : value));
          notifyNotificationsChanged("bell");
        } catch {
          if (mounted.current) setError("Notification could not be marked as read.");
          return false;
        }
      }
      if (!mounted.current) return false;
      setOpen(false);
      return true;
    } finally {
      actionInFlight.current = false;
    }
  }
  async function openLinked(event: MouseEvent<HTMLAnchorElement>, item: UserNotification) { event.preventDefault(); if (await openItem(item)) router.push(item.linkPath!); }
  const notificationsHref = returnTo && returnTo !== "/notifications" ? `/notifications?returnTo=${encodeURIComponent(returnTo)}` : "/notifications";
  return <DropdownMenu.Root open={open} onOpenChange={onOpenChange}><DropdownMenu.Trigger asChild><Button variant="quiet" size="icon" className="relative" aria-label="Open notifications"><Bell size={17} />{unread.length > 0 ? <span className="absolute right-0 top-0 grid min-w-4 place-items-center rounded-full bg-error px-1 text-[10px] text-white">{unread.length > 99 ? "99+" : unread.length}</span> : null}</Button></DropdownMenu.Trigger><DropdownContent align="end" className="w-[min(24rem,calc(100vw-1rem))] p-0"><header className="flex items-center justify-between gap-3 border-b border-subtle px-4 py-3"><strong className="text-sm text-foreground">Notifications</strong>{unread.length > 0 ? <Button variant="quiet" size="sm" disabled={markingAll} onClick={() => void markAllRead()}><CheckCheck size={15} />{markingAll ? "Marking..." : "Mark all read"}</Button> : null}</header><div className="max-h-96 overflow-y-auto">{loading ? <p className="px-4 py-8 text-center text-sm text-secondary">Loading notifications...</p> : null}{error ? <div className="space-y-2 px-4 py-4" role="alert"><p className="text-sm text-error">{error}</p><Button variant="quiet" size="sm" onClick={() => void load()}>Retry</Button></div> : null}{!loading && !error && items.length === 0 ? <p className="px-4 py-8 text-center text-sm text-secondary">No notifications</p> : null}{!loading && !error && items.slice(0, 20).map((item) => <NotificationMenuItem item={item} onOpen={openItem} onOpenLinked={openLinked} key={item.id} />)}</div><footer className="border-t border-subtle p-2"><Link href={notificationsHref} onClick={() => setOpen(false)} className="block rounded-sm px-3 py-2 text-center text-sm text-secondary hover:bg-hover hover:text-foreground">View all notifications</Link></footer></DropdownContent></DropdownMenu.Root>;
}
function NotificationMenuItem({ item, onOpen, onOpenLinked }: { item: UserNotification; onOpen: (item: UserNotification) => Promise<boolean>; onOpenLinked: (event: MouseEvent<HTMLAnchorElement>, item: UserNotification) => Promise<void> }) { const body = <div className={`block px-4 py-3 text-left hover:bg-hover ${item.readAt ? "text-secondary" : "bg-surface-low text-foreground"}`}><p className="text-sm font-medium">{item.title}</p>{item.body ? <p className="mt-1 line-clamp-2 text-xs text-secondary">{item.body}</p> : null}<p className="mt-1 text-xs text-tertiary">{formatDate(item.createdAt)}</p></div>; return item.linkPath ? <Link href={item.linkPath} onClick={(event) => void onOpenLinked(event, item)}>{body}</Link> : <button type="button" className="block w-full" onClick={() => void onOpen(item)}>{body}</button>; }
function formatDate(value: string) { return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
