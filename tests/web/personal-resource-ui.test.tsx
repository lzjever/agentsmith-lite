import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import React from "react";
import { apiClient, type ProjectCapabilities, type ProjectMember, type UserNotification } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { MembersPage } = await import("../../src/components/members/MembersPage.js");
const { NotificationsPage } = await import("../../src/components/notifications/NotificationsPage.js");
const { NotificationBell } = await import("../../src/components/notifications/NotificationBell.js");

afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

const capabilities: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: false, canCreateTasks: false, canCancelTasks: false, canSendChat: false };
const members: ProjectMember[] = [{ projectId: "project_1", userId: "viewer_1", role: "viewer", displayName: "Viewer Person", email: "viewer@example.test", createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-12T00:00:00.000Z" }, { projectId: "project_1", userId: "admin_1", role: "admin", displayName: null, email: "admin@example.test", createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" }];
const notification: UserNotification = { id: "notice_1", type: "task", title: "Task finished", body: "Validation project: task completed.", projectId: "project_1", resourceKind: "task", resourceId: "task_1", linkPath: null, readAt: null, createdAt: "2026-07-12T00:00:00.000Z" };

describe("personal and resource UI", () => {
  it("filters members using actual roles and exposes only safe membership detail fields", async () => {
    const original = { members: apiClient.members, projectCapabilities: apiClient.projectCapabilities };
    apiClient.members = async () => members;
    apiClient.projectCapabilities = async () => capabilities;
    try {
      render(<MembersPage workspaceId="workspace_1" projectId="project_1" />);
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
      render(<AppRouterContext.Provider value={router()}><NotificationsPage /></AppRouterContext.Provider>);
      await screen.findByText("Task finished");
      assert.ok(screen.getByText("Validation project: task completed."));
      fireEvent.click(screen.getByRole("button", { name: "Mark notification read" }));
      await screen.findByRole("alert");
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => assert.equal(attempts, 2));
      assert.equal(screen.queryByRole("button", { name: "Mark notification read" }), null);
    } finally { apiClient.notifications = original.notifications; apiClient.markNotificationRead = original.markNotificationRead; }
  });

  it("marks a linked notification read before navigating to its resource", async () => {
    const original = { notifications: apiClient.notifications, markNotificationRead: apiClient.markNotificationRead };
    const pushed: string[] = [];
    let finishRead!: (value: UserNotification) => void;
    const linked = { ...notification, linkPath: "/workspaces/workspace_1/projects/project_1/tasks/task_1" };
    apiClient.notifications = async () => [linked];
    apiClient.markNotificationRead = async () => new Promise((resolve) => { finishRead = resolve; });
    try {
      render(<AppRouterContext.Provider value={router(pushed)}><NotificationsPage /></AppRouterContext.Provider>);
      fireEvent.click(await screen.findByRole("link", { name: "Task finished" }));
      assert.deepEqual(pushed, []);
      finishRead({ ...linked, readAt: "2026-07-12T00:01:00.000Z" });
      await waitFor(() => assert.deepEqual(pushed, [linked.linkPath]));
    } finally { Object.assign(apiClient, original); }
  });

  it("does not navigate after a pending notification read leaves the page", async () => {
    const original = { notifications: apiClient.notifications, markNotificationRead: apiClient.markNotificationRead };
    const pushed: string[] = [];
    let finishRead: ((value: UserNotification) => void) | undefined;
    const linked = { ...notification, linkPath: "/workspaces/workspace_1/projects/project_1/tasks/task_1" };
    apiClient.notifications = async () => [linked];
    apiClient.markNotificationRead = async () => new Promise((resolve) => { finishRead = resolve; });
    try {
      const view = render(<AppRouterContext.Provider value={router(pushed)}><NotificationsPage /></AppRouterContext.Provider>);
      fireEvent.click(await screen.findByRole("link", { name: "Task finished" }));
      await waitFor(() => assert.ok(finishRead));
      view.unmount();
      await act(async () => finishRead!({ ...linked, readAt: "2026-07-12T00:01:00.000Z" }));
      assert.deepEqual(pushed, []);
    } finally { Object.assign(apiClient, original); }
  });

  it("shows safe notification context in the global bell", async () => {
    const original = apiClient.notifications;
    apiClient.notifications = async () => [notification];
    try {
      render(<AppRouterContext.Provider value={router()}><NotificationBell returnTo="/workspaces/workspace_1/projects/project_1/tasks" /></AppRouterContext.Provider>);
      fireEvent.pointerDown(screen.getByRole("button", { name: "Open notifications" }), { button: 0, ctrlKey: false });
      await screen.findByText("Validation project: task completed.");
      assert.ok(screen.getByText("Task finished"));
      assert.equal(screen.getByRole("link", { name: "View all notifications" }).getAttribute("href"), "/notifications?returnTo=%2Fworkspaces%2Fworkspace_1%2Fprojects%2Fproject_1%2Ftasks");
    } finally { apiClient.notifications = original; }
  });

  it("does not let the initial unread request overwrite a newer opened menu", async () => {
    const original = apiClient.notifications;
    const stale = { ...notification, title: "Stale unread notification" };
    const latest = { ...notification, id: "notice_latest", title: "Latest read notification", readAt: "2026-07-12T00:01:00.000Z" };
    let resolveInitial!: (value: UserNotification[]) => void;
    apiClient.notifications = async (unreadOnly) => unreadOnly ? new Promise((resolve) => { resolveInitial = resolve; }) : [latest];
    try {
      render(<AppRouterContext.Provider value={router()}><NotificationBell /></AppRouterContext.Provider>);
      fireEvent.pointerDown(screen.getByRole("button", { name: "Open notifications" }), { button: 0, ctrlKey: false });
      await screen.findByText("Latest read notification");
      assert.equal(screen.queryByRole("button", { name: "Mark all read" }), null);
      await act(async () => { resolveInitial([stale]); await Promise.resolve(); });
      assert.equal(screen.queryByText("Stale unread notification"), null);
      assert.ok(screen.getByText("Latest read notification"));
      assert.equal(screen.queryByRole("button", { name: "Mark all read" }), null);
    } finally { apiClient.notifications = original; }
  });

  it("keeps the notification menu open until a linked item is marked read", async () => {
    const original = { notifications: apiClient.notifications, markNotificationRead: apiClient.markNotificationRead };
    const pushed: string[] = [];
    let finishRead!: (value: UserNotification) => void;
    const linked = { ...notification, linkPath: "/workspaces/workspace_1/projects/project_1/tasks/task_1" };
    apiClient.notifications = async () => [linked];
    apiClient.markNotificationRead = async () => new Promise((resolve) => { finishRead = resolve; });
    try {
      render(<AppRouterContext.Provider value={router(pushed)}><NotificationBell /></AppRouterContext.Provider>);
      fireEvent.pointerDown(screen.getByRole("button", { name: "Open notifications" }), { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole("link", { name: /Task finished/ }));
      assert.deepEqual(pushed, []);
      assert.ok(screen.getByText("Validation project: task completed."));
      finishRead({ ...linked, readAt: "2026-07-12T00:01:00.000Z" });
      await waitFor(() => assert.deepEqual(pushed, [linked.linkPath]));
    } finally { Object.assign(apiClient, original); }
  });

  it("marks all notifications read with one server operation", async () => {
    const original = { notifications: apiClient.notifications, markAllNotificationsRead: apiClient.markAllNotificationsRead };
    const second = { ...notification, id: "notice_2", title: "Another task finished" };
    let attempts = 0;
    apiClient.notifications = async () => [notification, second];
    apiClient.markAllNotificationsRead = async () => { attempts += 1; return [notification, second].map((item) => ({ ...item, readAt: "2026-07-12T00:01:00.000Z" })); };
    try {
      render(<AppRouterContext.Provider value={router()}><NotificationBell /></AppRouterContext.Provider>);
      fireEvent.pointerDown(screen.getByRole("button", { name: "Open notifications" }), { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
      await waitFor(() => assert.equal(attempts, 1));
      await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Mark all read" }), null));
    } finally { Object.assign(apiClient, original); }
  });

  it("does not let an older menu load undo mark all read", async () => {
    const original = { notifications: apiClient.notifications, markAllNotificationsRead: apiClient.markAllNotificationsRead };
    let initialLoaded = false;
    let finishMenuLoad: ((value: UserNotification[]) => void) | undefined;
    apiClient.notifications = async (unreadOnly) => {
      if (unreadOnly) { initialLoaded = true; return [notification]; }
      return new Promise((resolve) => { finishMenuLoad = resolve; });
    };
    apiClient.markAllNotificationsRead = async () => [{ ...notification, readAt: "2026-07-12T00:01:00.000Z" }];
    try {
      render(<AppRouterContext.Provider value={router()}><NotificationBell /></AppRouterContext.Provider>);
      await waitFor(() => assert.equal(initialLoaded, true));
      fireEvent.pointerDown(screen.getByRole("button", { name: "Open notifications" }), { button: 0, ctrlKey: false });
      await waitFor(() => assert.ok(finishMenuLoad));
      fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
      await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Mark all read" }), null));

      await act(async () => finishMenuLoad!([notification]));
      assert.equal(screen.queryByRole("button", { name: "Mark all read" }), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps a project return path and explains notification load failures", async () => {
    const original = apiClient.notifications;
    apiClient.notifications = async () => { throw new Error("offline"); };
    window.history.replaceState({}, "", "/notifications?returnTo=%2Fworkspaces%2Fworkspace_1%2Fprojects%2Fproject_1%2Ftasks");
    try {
      render(<AppRouterContext.Provider value={router()}><NotificationsPage /></AppRouterContext.Provider>);
      const alert = await screen.findByRole("alert");
      assert.ok(alert.textContent?.includes("Notifications could not be loaded."));
      assert.equal(screen.getByRole("link", { name: "Back to project" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/tasks");
      assert.ok(screen.getByRole("button", { name: "Try again" }));
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

function router(pushed: string[] = []) { return { back() {}, forward() {}, refresh() {}, push(path: string) { pushed.push(path); }, replace() {}, prefetch() {} }; }
