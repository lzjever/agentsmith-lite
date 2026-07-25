import assert from "node:assert/strict";
import test from "node:test";
import {
  NotificationListCoordinator,
  shouldActivateLinkedNotification
} from "../../src/components/notifications/notification-list-state.ts";

type Item = { id: string; readAt: string | null };

test("notification mutations invalidate stale loads and merge into the latest snapshot", () => {
  const coordinator = new NotificationListCoordinator<Item>();
  coordinator.replace([
    { id: "notification_1", readAt: null },
    { id: "notification_2", readAt: null }
  ]);
  const staleLoad = coordinator.beginLoad();

  assert.equal(coordinator.beginItemMutation("notification_1"), true);
  assert.equal(coordinator.isCurrentLoad(staleLoad), false);
  const loadStartedDuringMutation = coordinator.beginLoad();
  assert.deepEqual(coordinator.merge({ id: "notification_1", readAt: "2026-07-24T12:00:00.000Z" }), [
    { id: "notification_1", readAt: "2026-07-24T12:00:00.000Z" },
    { id: "notification_2", readAt: null }
  ]);
  assert.equal(coordinator.isCurrentLoad(loadStartedDuringMutation), false);
  assert.deepEqual(coordinator.remove("notification_2"), [
    { id: "notification_1", readAt: "2026-07-24T12:00:00.000Z" }
  ]);
});

test("notification collection mutations invalidate loads started while the request was pending", () => {
  const coordinator = new NotificationListCoordinator<Item>();
  coordinator.replace([{ id: "notification_1", readAt: null }]);
  coordinator.invalidateLoads();
  const loadStartedDuringMutation = coordinator.beginLoad();

  assert.deepEqual(coordinator.replaceAfterMutation([
    { id: "notification_1", readAt: "2026-07-24T12:00:00.000Z" }
  ]), [
    { id: "notification_1", readAt: "2026-07-24T12:00:00.000Z" }
  ]);
  assert.equal(coordinator.isCurrentLoad(loadStartedDuringMutation), false);
});

test("linked notification activation is deduplicated until its mutation finishes", () => {
  const coordinator = new NotificationListCoordinator<Item>();
  assert.equal(coordinator.beginItemMutation("notification_1"), true);
  assert.equal(coordinator.beginItemMutation("notification_1"), false);
  coordinator.endItemMutation("notification_1");
  assert.equal(coordinator.beginItemMutation("notification_1"), true);
});

test("linked notification activation accepts clicks and only middle-button auxclicks", () => {
  assert.equal(shouldActivateLinkedNotification("click", 0), true);
  assert.equal(shouldActivateLinkedNotification("click", 1), false);
  assert.equal(shouldActivateLinkedNotification("auxclick", 1), true);
  assert.equal(shouldActivateLinkedNotification("auxclick", 0), false);
  assert.equal(shouldActivateLinkedNotification("auxclick", 2), false);
});
