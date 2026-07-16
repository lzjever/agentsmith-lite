import { nowIso } from "../../domain/src/ids.js";
import { NotFoundError } from "../../domain/src/errors.js";
import type { ProductStore } from "../../ports/src/store.js";

export class NotificationService {
  constructor(private readonly store: ProductStore) {}
  list(userId: string, unreadOnly = false) { return this.store.listUserNotifications(userId, unreadOnly); }
  async markRead(userId: string, notificationId: string) { const value = await this.store.markUserNotificationRead(notificationId, userId, nowIso()); if (!value) throw new NotFoundError("Notification not found"); return value; }
  async markAllRead(userId: string) { await this.store.markAllUserNotificationsRead(userId, nowIso()); return this.store.listUserNotifications(userId); }
  async dismiss(userId: string, notificationId: string) { if (!await this.store.dismissUserNotification(notificationId, userId)) throw new NotFoundError("Notification not found"); return { dismissed: true }; }
}
