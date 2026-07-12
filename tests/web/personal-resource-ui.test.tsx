import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { apiClient, type ProjectCapabilities, type ProjectMember, type UserNotification } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { MembersPage } = await import("../../src/components/members/MembersPage.js");
const { NotificationsPage } = await import("../../src/components/notifications/NotificationsPage.js");
const { NotificationBell } = await import("../../src/components/notifications/NotificationBell.js");

afterEach(() => cleanup());

const capabilities: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: false, canCreateTasks: false, canCancelTasks: false, canSendChat: false };
const members: ProjectMember[] = [{ projectId: "project_1", userId: "viewer_1", role: "viewer", displayName: "Viewer Person", email: "viewer@example.test", createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-12T00:00:00.000Z" }, { projectId: "project_1", userId: "admin_1", role: "admin", displayName: null, email: "admin@example.test", createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" }];
const notification: UserNotification = { id: "notice_1", type: "task", title: "Task finished", body: "Validation project: task completed.", projectId: "project_1", resourceKind: "task", resourceId: "task_1", linkPath: null, readAt: null, createdAt: "2026-07-12T00:00:00.000Z" };

describe("personal and resource UI", () => {
  it("filters members using actual roles and exposes only safe membership detail fields", async () => {
    const original = { members: apiClient.members, projectCapabilities: apiClient.projectCapabilities };
    apiClient.members = async () => members;
    apiClient.projectCapabilities = async () => capabilities;
    try {
      render(<MembersPage projectId="project_1" />);
      await screen.findAllByText("Viewer Person");
      fireEvent.change(screen.getByRole("textbox", { name: "Search members" }), { target: { value: "viewer@example.test" } });
      assert.ok(screen.getAllByText("Viewer Person").length > 0);
      fireEvent.click(screen.getByRole("combobox", { name: "Member role" }));
      fireEvent.click(await screen.findByRole("option", { name: "Viewer" }));
      await waitFor(() => assert.equal(screen.queryAllByText("admin_1").length, 0));
      fireEvent.click(screen.getAllByText("Viewer Person")[0]!);
      await screen.findByRole("heading", { name: "Member details" });
      assert.ok(screen.getAllByText("2026", { exact: false }).length > 0);
      assert.ok(screen.getByText("Email"));
      assert.ok(screen.getAllByText("viewer@example.test").length > 0);
    } finally { apiClient.members = original.members; apiClient.projectCapabilities = original.projectCapabilities; }
  });

  it("keeps a notification mutation failure on the affected item and retries it", async () => {
    const original = { notifications: apiClient.notifications, markNotificationRead: apiClient.markNotificationRead };
    let attempts = 0;
    apiClient.notifications = async () => [notification];
    apiClient.markNotificationRead = async () => { attempts += 1; if (attempts === 1) throw new Error("offline"); return { ...notification, readAt: "2026-07-12T00:01:00.000Z" }; };
    try {
      render(<NotificationsPage />);
      await screen.findByText("Task finished");
      assert.ok(screen.getByText("Validation project: task completed."));
      fireEvent.click(screen.getByRole("button", { name: "Mark notification read" }));
      await screen.findByRole("alert");
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => assert.equal(attempts, 2));
      assert.equal(screen.queryByRole("button", { name: "Mark notification read" }), null);
    } finally { apiClient.notifications = original.notifications; apiClient.markNotificationRead = original.markNotificationRead; }
  });

  it("shows safe notification context in the global bell", async () => {
    const original = apiClient.notifications;
    apiClient.notifications = async () => [notification];
    try {
      render(<NotificationBell />);
      fireEvent.pointerDown(screen.getByRole("button", { name: "Open notifications" }), { button: 0, ctrlKey: false });
      await screen.findByText("Validation project: task completed.");
      assert.ok(screen.getByText("Task finished"));
    } finally { apiClient.notifications = original; }
  });
});

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {} });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
