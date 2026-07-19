import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { USER_NOTIFICATION_INBOX_LIMIT } from "../../packages/adapters-postgres/src/notificationRetention.js";
import type { UserNotification } from "../../packages/contracts/src/api.js";

describe("notification retention", () => {
  it("keeps each user's newest notifications in a bounded inbox", async () => {
    const store = createLocalInMemoryProductStore();
    for (let index = 0; index < USER_NOTIFICATION_INBOX_LIMIT + 2; index += 1) {
      await store.createUserNotification(notification("owner", index));
    }
    await store.createUserNotification(notification("other", 0));

    const retained = await store.listUserNotifications("owner");
    assert.equal(retained.length, USER_NOTIFICATION_INBOX_LIMIT);
    assert.equal(retained[0]?.id, "notice_owner_101");
    assert.equal(retained.at(-1)?.id, "notice_owner_2");
    assert.deepEqual((await store.listUserNotifications("other")).map((item) => item.id), ["notice_other_0"]);
  });
});

function notification(userId: string, index: number): UserNotification {
  return {
    id: `notice_${userId}_${index}`,
    userId,
    type: "task" as const,
    title: `Notification ${index}`,
    body: null,
    projectId: null,
    resourceKind: "task",
    resourceId: `task_${index}`,
    linkPath: null,
    readAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
  };
}
