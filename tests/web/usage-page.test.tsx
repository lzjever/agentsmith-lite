import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type ProjectUsageOverview } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { UsagePage } = await import("../../src/components/resources/AuditUsagePage.js");

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

const overview: ProjectUsageOverview = { projectId: "project_1", usage: { projectId: "project_1", activeTasks: 1, providerRequests: 4, providerTokens: 42, providerCost: 2.5, projectFileBytes: 1024, updatedAt: "2026-07-11T00:00:00.000Z" }, limits: [{ metric: "activeTasks", current: 1, limit: 2, remaining: 1, window: { kind: "current_gauge", resetAt: null } }, { metric: "providerRequests", current: 4, limit: 8, remaining: 4, window: { kind: "project_lifetime", startedAt: "2026-07-01T00:00:00.000Z", resetAt: null } }, { metric: "providerTokens", current: 42, limit: 100, remaining: 58, window: { kind: "project_lifetime", startedAt: "2026-07-01T00:00:00.000Z", resetAt: null } }, { metric: "providerCost", current: 2.5, limit: null, remaining: null, window: { kind: "project_lifetime", startedAt: "2026-07-01T00:00:00.000Z", resetAt: null } }, { metric: "projectFileBytes", current: 1024, limit: 2048, remaining: 1024, window: { kind: "current_gauge", resetAt: null } }], daily: Array.from({ length: 30 }, (_, index) => ({ date: `2026-07-${String(index + 1).padStart(2, "0")}`, requests: index === 29 ? 4 : 0, tokens: index === 29 ? 42 : 0, cost: index === 29 ? 2.5 : 0 })), trendTotals: { requests: 4, tokens: 42, cost: 2.5 }, endpoints: [{ endpointId: "endpoint_1", endpointName: "Primary", requests: 4, tokens: 42, cost: 2.5 }, { endpointId: "endpoint_2", endpointName: "Secondary", requests: 1, tokens: 2, cost: 0.0068 }], selectedEndpointId: null, sandbox: { selectedUserId: "user_self", activeCount: 1, launches: 2, totalDurationSeconds: "9007199254740993.125", cpuRequestSeconds: "12345678901234567890.5", memoryRequestByteSeconds: "1152921504606846976", rows: [{ taskId: "task_live", runId: "run_live", fileLibraryId: "library_live", state: "live", startedAt: "2026-07-19T00:00:00.000Z", releasedAt: null, durationSeconds: 12.5, resources: { cpuRequestMillis: "250", memoryRequestBytes: "536870912", cpuLimitMillis: "1000", memoryLimitBytes: "1073741824" }, releaseReason: null }, { taskId: "task_settled", runId: "run_settled", fileLibraryId: "library_settled", state: "settled", startedAt: "2026-07-18T00:00:00.000Z", releasedAt: "2026-07-18T00:01:00.000Z", durationSeconds: 60, resources: { cpuRequestMillis: "500", memoryRequestBytes: "1073741824", cpuLimitMillis: "2000", memoryLimitBytes: "2147483648" }, releaseReason: "requested" }] } };
const overviewWithUnassigned = { ...overview, endpoints: [...overview.endpoints, { endpointId: null, endpointName: "Other provider activity", requests: 3, tokens: 9, cost: 0 }] } satisfies ProjectUsageOverview;

describe("usage page", () => {
  it("renders server-computed limit cards and requests an endpoint-filtered trend", async () => {
    const original = { usage: apiClient.usage, currentIdentity: apiClient.currentIdentity, members: apiClient.members };
    const requested: Array<{ endpointId?: string; userId?: string }> = [];
    apiClient.currentIdentity = async () => ({ user: { id: "user_self", email: "self@example.test" } });
    apiClient.members = async () => [{ projectId: "project_1", userId: "user_self", role: "member", displayName: "Self User", email: "self@example.test", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }];
    apiClient.usage = async (_projectId, query) => { requested.push(query); return query.endpointId === "endpoint_2" ? { ...overviewWithUnassigned, selectedEndpointId: query.endpointId, daily: overview.daily.map((day) => ({ ...day, requests: 0, tokens: 0, cost: 0 })), trendTotals: { requests: 0, tokens: 0, cost: 0 } } : overviewWithUnassigned; };
    try {
      render(<UsagePage projectId="project_1" />);
      await screen.findByRole("heading", { name: "Project limits" });
      assert.ok(screen.getByRole("heading", { name: "Usage scope" }));
      assert.ok(screen.getByRole("combobox", { name: "Usage scope endpoint" }));
      assert.equal(screen.queryByRole("combobox", { name: "Usage endpoint" }), null);
      assert.ok(screen.getByText("The endpoint filter applies to your settled 30-day provider usage. Project lifetime limits and settled endpoint totals remain project-wide; rolling endpoint limits show your capacity."));
      assert.ok(screen.getByText("Provider totals include conservative reservations when final delivery usage is unknown."));
      assert.ok(screen.getByText(/\$0\.0068/));
      assert.ok(screen.getByText("58 remaining of 100"));
      assert.equal(screen.getAllByText("Current state").length, 2);
      assert.equal(screen.getAllByText(/^Project lifetime · started/).length, 3);
      assert.equal(screen.queryByText("Current usage is measured for the project lifetime. It does not reset."), null);
      assert.ok(screen.getByLabelText("30-day request trend"));
      assert.ok(screen.getByText("Other provider activity"));
      assert.ok(screen.getByRole("heading", { name: "Sandbox usage" }));
      assert.equal(screen.queryByRole("combobox", { name: "Sandbox usage member" }), null);
      assert.ok(screen.getByText("9,007,199,254,740,993.13 s"));
      assert.ok(screen.getByText("12,345,678,901,234,567,890.5 CPU-s"));
      assert.ok(screen.getByText("1,073,741,824 GiB-s"));
      assert.ok(screen.getByText("Live"));
      assert.ok(screen.getByText("Settled"));
      assert.equal(screen.getByRole("link", { name: /Task task_live/ }).getAttribute("href"), "../tasks/task_live");
      fireEvent.click(screen.getByRole("combobox", { name: "Usage scope endpoint" }));
      assert.equal(screen.queryByRole("option", { name: "Other provider activity" }), null);
      fireEvent.click(await screen.findByRole("option", { name: "Secondary" }));
      await screen.findByText("No settled provider usage in this period.");
      await waitFor(() => assert.deepEqual(requested, [{}, { endpointId: "endpoint_2" }]));
      assert.equal(new URL(window.location.href).searchParams.get("endpointId"), "endpoint_2");
    } finally { Object.assign(apiClient, original); }
  });

  it("falls back to all endpoints when a linked endpoint no longer exists", async () => {
    const original = apiClient.usage;
    const requested: Array<{ endpointId?: string; userId?: string }> = [];
    window.history.replaceState(null, "", "/usage?endpointId=endpoint_deleted");
    apiClient.usage = async (_projectId, query) => {
      requested.push(query);
      if (query.endpointId) throw new ApiError(404, "Endpoint not found");
      return overview;
    };
    try {
      render(<UsagePage projectId="project_1" />);
      await screen.findByRole("heading", { name: "Project limits" });
      assert.deepEqual(requested, [{ endpointId: "endpoint_deleted" }, {}]);
      assert.equal(new URL(window.location.href).searchParams.has("endpointId"), false);
    } finally {
      apiClient.usage = original;
      window.history.replaceState(null, "", "/");
    }
  });

  it("lets project admins switch sandbox usage to a current member", async () => {
    const original = { usage: apiClient.usage, currentIdentity: apiClient.currentIdentity, members: apiClient.members };
    const requested: Array<{ endpointId?: string; userId?: string }> = [];
    apiClient.currentIdentity = async () => ({ user: { id: "user_admin", email: "admin@example.test" } });
    apiClient.members = async () => [
      { projectId: "project_1", userId: "user_admin", role: "admin", displayName: "Admin User", email: "admin@example.test", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
      { projectId: "project_1", userId: "user_member", role: "member", displayName: "Member User", email: "member@example.test", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
    ];
    apiClient.usage = async (_projectId, query) => { requested.push(query); return { ...overview, sandbox: { ...overview.sandbox, selectedUserId: query.userId ?? "user_admin" } }; };
    try {
      render(<UsagePage projectId="project_1" />);
      const selector = await screen.findByRole("combobox", { name: "Sandbox usage member" });
      fireEvent.click(selector);
      fireEvent.click(await screen.findByRole("option", { name: "Member User (member@example.test)" }));
      await waitFor(() => assert.deepEqual(requested, [{}, { userId: "user_member" }]));
      assert.ok(screen.getByText(/for Member User \(member@example.test\)/));
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps other usage visible when a refresh reports sandbox usage unavailable", async () => {
    const original = { usage: apiClient.usage, currentIdentity: apiClient.currentIdentity, members: apiClient.members };
    let reads = 0;
    apiClient.currentIdentity = async () => ({ user: { id: "user_self", email: "self@example.test" } });
    apiClient.members = async () => [];
    apiClient.usage = async () => { if (++reads === 1) return overview; throw new ApiError(503, "Sandbox usage mismatch", "sandbox_usage_unavailable"); };
    try {
      render(<UsagePage projectId="project_1" />);
      await screen.findByRole("heading", { name: "Project limits" });
      fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
      assert.ok(await screen.findByRole("alert"));
      assert.ok(screen.getByText("Sandbox accounting is temporarily unavailable. Retry after the run state is reconciled."));
      assert.ok(screen.getByRole("heading", { name: "Project limits" }));
    } finally { Object.assign(apiClient, original); }
  });

  it("ignores old project member and usage responses after switching projects", async () => {
    const original = { usage: apiClient.usage, currentIdentity: apiClient.currentIdentity, members: apiClient.members };
    const oldUsage = deferred<ProjectUsageOverview>();
    const oldMembers = deferred<Awaited<ReturnType<typeof apiClient.members>>>();
    let identityReads = 0;
    apiClient.currentIdentity = async () => ({ user: identityReads++ === 0 ? { id: "old_admin", email: "old@example.test" } : { id: "new_admin", email: "new@example.test" } });
    apiClient.members = async (projectId) => projectId === "project_1" ? oldMembers.promise : [{ projectId, userId: "new_admin", role: "admin", displayName: "New Admin", email: "new@example.test", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }];
    apiClient.usage = async (projectId) => projectId === "project_1" ? oldUsage.promise : usageFor("project_2", "new_admin", "New project endpoint");
    try {
      const view = render(<UsagePage projectId="project_1" />);
      await waitFor(() => assert.equal(identityReads, 1));
      view.rerender(<UsagePage projectId="project_2" />);
      assert.equal(screen.queryByText("Primary"), null);
      assert.ok(await screen.findByText("New project endpoint"));
      await act(async () => {
        oldMembers.resolve([{ projectId: "project_1", userId: "old_admin", role: "admin", displayName: "Old Admin", email: "old@example.test", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }]);
        oldUsage.resolve(usageFor("project_1", "old_admin", "Old project endpoint"));
        await Promise.resolve();
      });
      assert.equal(screen.queryByText("Old project endpoint"), null);
      fireEvent.click(await screen.findByRole("combobox", { name: "Sandbox usage member" }));
      assert.ok(await screen.findByRole("option", { name: "New Admin (new@example.test)" }));
      assert.equal(screen.queryByRole("option", { name: "Old Admin (old@example.test)" }), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("does not render old project data when the new project returns 503", async () => {
    const original = { usage: apiClient.usage, currentIdentity: apiClient.currentIdentity, members: apiClient.members };
    apiClient.currentIdentity = async () => ({ user: { id: "user_self", email: "self@example.test" } });
    apiClient.members = async () => [];
    apiClient.usage = async (projectId) => {
      if (projectId === "project_1") return usageFor("project_1", "user_self", "Old project endpoint");
      throw new ApiError(503, "Sandbox usage mismatch", "sandbox_usage_unavailable");
    };
    try {
      const view = render(<UsagePage projectId="project_1" />);
      await screen.findByText("Old project endpoint");
      view.rerender(<UsagePage projectId="project_2" />);
      assert.equal(screen.queryByText("Old project endpoint"), null);
      assert.ok(await screen.findByRole("heading", { name: "Sandbox usage unavailable" }));
      assert.equal(screen.queryByRole("heading", { name: "Project limits" }), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("only applies the latest rapid member selection response", async () => {
    const original = { usage: apiClient.usage, currentIdentity: apiClient.currentIdentity, members: apiClient.members };
    const memberAUsage = deferred<ProjectUsageOverview>();
    const memberBUsage = deferred<ProjectUsageOverview>();
    apiClient.currentIdentity = async () => ({ user: { id: "user_admin", email: "admin@example.test" } });
    apiClient.members = async () => [
      member("user_admin", "admin", "Admin User"),
      member("user_a", "member", "Member A"),
      member("user_b", "member", "Member B"),
    ];
    apiClient.usage = async (_projectId, query) => query.userId === "user_a" ? memberAUsage.promise : query.userId === "user_b" ? memberBUsage.promise : usageFor("project_1", "user_admin", "Admin endpoint");
    try {
      render(<UsagePage projectId="project_1" />);
      const selector = await screen.findByRole("combobox", { name: "Sandbox usage member" });
      fireEvent.click(selector);
      fireEvent.click(await screen.findByRole("option", { name: "Member A (user_a@example.test)" }));
      fireEvent.click(screen.getByRole("combobox", { name: "Sandbox usage member" }));
      fireEvent.click(await screen.findByRole("option", { name: "Member B (user_b@example.test)" }));
      await act(async () => {
        memberAUsage.resolve(usageFor("project_1", "user_a", "Member A endpoint"));
        await Promise.resolve();
      });
      assert.equal(screen.queryByText("Member A endpoint"), null);
      await act(async () => {
        memberBUsage.resolve(usageFor("project_1", "user_b", "Member B endpoint"));
        await Promise.resolve();
      });
      assert.ok(await screen.findByText("Member B endpoint"));
      assert.equal(screen.queryByText("Member A endpoint"), null);
      assert.ok(screen.getByText(/for Member B \(user_b@example.test\)/));
    } finally { Object.assign(apiClient, original); }
  });
});

function usageFor(projectId: string, userId: string, endpointName: string): ProjectUsageOverview {
  return { ...overview, projectId, usage: { ...overview.usage, projectId }, endpoints: [{ ...overview.endpoints[0]!, endpointName }], sandbox: { ...overview.sandbox, selectedUserId: userId, rows: [] } };
}

function member(userId: string, role: "admin" | "member", displayName: string) {
  return { projectId: "project_1", userId, role, displayName, email: `${userId}@example.test`, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" } as const;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, HTMLFormElement: dom.window.HTMLFormElement, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {} });
  Object.assign(globalThis, { requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number, cancelAnimationFrame: (id: number) => clearTimeout(id) });
  Object.assign(dom.window, { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
