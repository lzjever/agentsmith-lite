"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { Badge, Banner, Button, EmptyState, IconButton, Popover, Text } from "@astryxdesign/core";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { apiClient, isMissingNotification, NOTIFICATIONS_CHANGED_EVENT, notificationChangeSource, notifyNotificationsChanged, type UserNotification } from "../../lib/api/client";
import { formatLocalDateTime } from "../../lib/format/date";
import { isCurrentAppPage } from "../../lib/navigation/return-path";

export function NotificationBell({ returnTo }: { returnTo?: string }) {
  const router = useRouter();
  const [items, setItems] = useState<UserNotification[]>([]); const [open, setOpen] = useState(false); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [markingAll, setMarkingAll] = useState(false); const [openingId, setOpeningId] = useState<string | null>(null);
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
  const actionBusy = markingAll || openingId !== null;
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
    setOpeningId(item.id);
    loadRevision.current += 1;
    setLoading(false);
    try {
      if (!item.readAt) {
        try {
          const saved = await apiClient.markNotificationRead(item.id);
          if (!mounted.current) return false;
          setItems((current) => current.map((value) => value.id === saved.id ? saved : value));
          notifyNotificationsChanged("bell");
        } catch (reason) {
          if (!mounted.current) return false;
          if (isMissingNotification(reason)) {
            setItems((current) => current.filter((value) => value.id !== item.id));
            notifyNotificationsChanged("bell");
          } else {
            setError("Notification could not be marked as read.");
            return false;
          }
        }
      }
      if (!mounted.current) return false;
      setOpen(false);
      return true;
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setOpeningId(null);
    }
  }
  async function openLinked(event: MouseEvent<HTMLAnchorElement>, item: UserNotification) { event.preventDefault(); if (await openItem(item)) router.push(item.linkPath!); }
  const notificationsHref = returnTo && !isCurrentAppPage(returnTo, "/notifications") ? `/notifications?returnTo=${encodeURIComponent(returnTo)}` : "/notifications";
  return <Popover isOpen={open} onOpenChange={onOpenChange} label="Notifications" placement="below" alignment="end" width="min(24rem, calc(100vw - 1rem))" className="p-0" content={<><header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3"><Text weight="semibold">Notifications</Text>{unread.length > 0 ? <Button label={markingAll ? "Marking..." : "Mark all read"} variant="ghost" size="sm" icon={<CheckCheck size={15} />} isDisabled={actionBusy} onClick={() => void markAllRead()}/> : null}</header><div className="max-h-96 overflow-y-auto">{loading ? <Text as="p" type="supporting" color="secondary" display="block" justify="center" className="px-4 py-8">Loading notifications...</Text> : null}{error ? <Banner className="m-3" status="error" title="Notifications unavailable" description={error} endContent={<Button label="Retry" variant="ghost" size="sm" onClick={() => void load()}/>} /> : null}{!loading && !error && items.length === 0 ? <EmptyState isCompact title="No notifications" /> : null}{!loading && !error && items.slice(0, 20).map((item) => <NotificationMenuItem item={item} disabled={actionBusy} onOpen={openItem} onOpenLinked={openLinked} key={item.id} />)}</div><footer className="border-t border-border p-2"><Link href={notificationsHref} onClick={() => setOpen(false)} className="block rounded-sm px-3 py-2 text-center hover:bg-overlay-hover hover:text-primary"><Text type="supporting" color="secondary">View all notifications</Text></Link></footer></>}>{({ ref, onClick, ...triggerProps }) => <IconButton ref={ref} label="Open notifications" tooltip="Open notifications" variant="ghost" className="relative p-2 text-secondary hover:bg-overlay-hover hover:text-primary" onClick={onClick} {...triggerProps} icon={<><Bell size={17} />{unread.length > 0 ? <Badge className="absolute right-0 top-0" variant="error" label={unread.length > 99 ? "99+" : String(unread.length)} /> : null}</>} />}</Popover>;
}
function NotificationMenuItem({ item, disabled, onOpen, onOpenLinked }: { item: UserNotification; disabled: boolean; onOpen: (item: UserNotification) => Promise<boolean>; onOpenLinked: (event: MouseEvent<HTMLAnchorElement>, item: UserNotification) => Promise<void> }) {
  const textColor = disabled ? "disabled" : item.readAt ? "secondary" : "primary";
  const body = <div className={`block px-4 py-3 text-left ${disabled ? "bg-muted" : `hover:bg-overlay-hover ${item.readAt ? "" : "bg-muted"}`}`}><Text weight={item.readAt ? "normal" : "semibold"} color={textColor} display="block">{item.title}</Text>{item.body ? <Text type="supporting" color={disabled ? "disabled" : "secondary"} display="block" maxLines={2} className="mt-1">{item.body}</Text> : null}<Text type="supporting" color={disabled ? "disabled" : "secondary"} display="block" className="mt-1">{formatLocalDateTime(item.createdAt)}</Text></div>;
  return item.linkPath
    ? <Link href={item.linkPath} aria-disabled={disabled} tabIndex={disabled ? -1 : undefined} className={disabled ? "pointer-events-none cursor-not-allowed text-disabled" : undefined} onClick={(event) => { if (disabled) event.preventDefault(); else void onOpenLinked(event, item); }}>{body}</Link>
    : <button type="button" className="block w-full disabled:cursor-not-allowed disabled:text-disabled" disabled={disabled} onClick={() => void onOpen(item)}>{body}</button>;
}
