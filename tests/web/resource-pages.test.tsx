import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type Endpoint, type ProjectAlert, type ProjectAuditEvent, type ProjectCapabilities, type ProjectPolicyInput, type ProjectResourcePolicy, type ProjectResourceUsage, type ProjectUsageOverview } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { ResourcePolicyPage } = await import("../../src/components/resources/ResourcePolicyPage.js");
const { AlertsPage } = await import("../../src/components/resources/AlertsPage.js");
const { AuditPage, UsagePage } = await import("../../src/components/resources/AuditUsagePage.js");

const projectId = "project_1";
const policy: ProjectResourcePolicy = { projectId, activeTasksLimit: 2, providerRequestsLimit: 10, providerTokensLimit: null, providerCostLimit: 3.5, projectFileBytesLimit: 2048, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" };
const capabilities: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: false, canManagePolicy: true, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true };
const usage: ProjectResourceUsage = { projectId, activeTasks: 1, providerRequests: 4, providerTokens: 50, providerCost: 1.25, projectFileBytes: 2048, updatedAt: "2026-07-11T00:00:00.000Z" };
const usageOverview: ProjectUsageOverview = { projectId, usage, limits: [{ metric: "activeTasks", current: 1, limit: 2, remaining: 1, window: { kind: "current_gauge", resetAt: null } }, { metric: "providerRequests", current: 4, limit: 10, remaining: 6, window: { kind: "project_lifetime", startedAt: "2026-07-01T00:00:00.000Z", resetAt: null } }, { metric: "providerTokens", current: 50, limit: null, remaining: null, window: { kind: "project_lifetime", startedAt: "2026-07-01T00:00:00.000Z", resetAt: null } }, { metric: "providerCost", current: 1.25, limit: 3.5, remaining: 2.25, window: { kind: "project_lifetime", startedAt: "2026-07-01T00:00:00.000Z", resetAt: null } }, { metric: "projectFileBytes", current: 2048, limit: 2048, remaining: 0, window: { kind: "current_gauge", resetAt: null } }], daily: Array.from({ length: 30 }, (_, index) => ({ date: `2026-07-${String(index + 1).padStart(2, "0")}`, requests: index === 29 ? 4 : 0, tokens: index === 29 ? 50 : 0, cost: index === 29 ? 1.25 : 0 })), trendTotals: { requests: 4, tokens: 50, cost: 1.25 }, endpoints: [{ endpointId: "endpoint_1", endpointName: "Primary", requests: 4, tokens: 50, cost: 1.25 }, { endpointId: "endpoint_2", endpointName: "Secondary", requests: 0, tokens: 0, cost: 0 }], selectedEndpointId: null };
const endpoint: Endpoint = { id: "endpoint_1", projectId, name: "Primary", protocol: "openai_chat_completions", baseUrl: "https://provider.example/v1", model: "model", credentialId: "credential_1", capabilities: ["text"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: policy.createdAt, updatedAt: policy.updatedAt };

afterEach(() => cleanup());

describe("project resource pages", () => {
  it("uses projected policy capability from the first ready render and sends the complete policy update", async () => {
    const original = snapshotClient();
    const updates: ProjectPolicyInput[] = [];
    apiClient.policy = async () => policy;
    apiClient.projectCapabilities = async () => ({ ...capabilities, canManagePolicy: false });
    apiClient.endpoints = async () => [];
    try {
      const view = render(<ResourcePolicyPage projectId={projectId} />);
      await screen.findByText("Read-only policy");
      assert.equal(screen.queryByRole("button", { name: "Save policy" }), null);
      assert.equal(screen.queryByRole("spinbutton", { name: "Active tasks" }), null);
      view.unmount();
    } finally { restoreClient(original); }

    apiClient.policy = async () => policy;
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [];
    apiClient.updatePolicy = async (_projectId, input) => { updates.push(input); return { ...policy, activeTasksLimit: input.activeTasksLimit ?? null, updatedAt: "2026-07-12T00:00:00.000Z" }; };
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      const activeTasks = await screen.findByRole("spinbutton", { name: "Active tasks" });
      assert.ok(screen.getByText("Project-wide gauges and lifetime provider budgets, with per-user endpoint rolling windows."));
      assert.ok(screen.getByText("Each limit applies independently to every user over the selected rolling window."));
      fireEvent.change(activeTasks, { target: { value: "5" } });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await waitFor(() => assert.equal(updates.length, 1));
      assert.deepEqual(updates[0], { activeTasksLimit: 5, providerRequestsLimit: 10, providerTokensLimit: null, providerCostLimit: 3.5, projectFileBytesLimit: 2048, endpointWindows: [] });
    } finally { restoreClient(original); }
  });

  it("honors a forbidden policy mutation while keeping the API authoritative", async () => {
    const original = snapshotClient();
    apiClient.policy = async () => policy;
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [];
    apiClient.updatePolicy = async () => { throw new ApiError(403, "forbidden"); };
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      await screen.findByRole("button", { name: "Save policy" });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await screen.findByRole("alert");
      assert.equal(screen.queryByRole("button", { name: "Save policy" }), null);
      assert.ok(screen.getByText("Read-only policy"));
    } finally { restoreClient(original); }
  });

  it("blocks policy saves when endpoints fail and refreshes every controlled field after recovery", async () => {
    const original = snapshotClient();
    const initial = { ...policy, endpointWindows: [{ endpointId: endpoint.id, metric: "providerRequests" as const, limit: 4, windowSeconds: 3600 }] };
    const refreshed = { ...initial, activeTasksLimit: 7, endpointWindows: [{ endpointId: endpoint.id, metric: "providerRequests" as const, limit: 9, windowSeconds: 86400 }], updatedAt: "2026-07-12T00:00:00.000Z" };
    let policyReads = 0;
    let endpointReads = 0;
    const updates: ProjectPolicyInput[] = [];
    apiClient.policy = async () => (++policyReads === 1 ? initial : refreshed);
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => {
      endpointReads += 1;
      if (endpointReads === 1) throw new Error("endpoint service unavailable");
      return [endpoint];
    };
    apiClient.updatePolicy = async (_projectId, input) => {
      updates.push(input);
      return refreshed;
    };
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      await screen.findByText(/Endpoint windows could not be loaded/);
      assert.equal(screen.getByRole("button", { name: "Save policy" }).hasAttribute("disabled"), true);
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      assert.equal(updates.length, 0);

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => assert.equal((screen.getByRole("spinbutton", { name: "Active tasks" }) as HTMLInputElement).value, "7"));
      assert.equal((screen.getByRole("spinbutton", { name: "Primary Requests limit" }) as HTMLInputElement).value, "9");
      assert.equal((screen.getByRole("combobox", { name: "Primary Requests window" }) as HTMLSelectElement).value, "86400");
      assert.equal(screen.getByRole("button", { name: "Save policy" }).hasAttribute("disabled"), false);
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await waitFor(() => assert.equal(updates.length, 1));
      assert.deepEqual(updates[0]?.endpointWindows, refreshed.endpointWindows);
    } finally { restoreClient(original); }
  });

  it("keeps a failed alert read distinct from an empty response and refreshes to current data", async () => {
    const original = snapshotClient();
    let attempts = 0;
    apiClient.alerts = async () => { attempts++; if (attempts === 1) throw new Error("network unavailable"); return []; };
    apiClient.projectCapabilities = async () => capabilities;
    try {
      render(<AlertsPage projectId={projectId} />);
      await screen.findByRole("heading", { name: "Alerts unavailable" });
      assert.equal(screen.queryByRole("heading", { name: "No project alert events" }), null);
      fireEvent.click(screen.getByRole("button", { name: "Refresh alerts" }));
      await screen.findByRole("heading", { name: "No alert instances" });
      assert.equal(attempts, 2);
    } finally { restoreClient(original); }
  });

  it("renders API-computed limits and trends, and refetches for the selected endpoint", async () => {
    const original = snapshotClient();
    const usageCalls: Array<string | undefined> = [];
    apiClient.usage = async (_projectId, endpointId) => { usageCalls.push(endpointId); return { ...usageOverview, selectedEndpointId: endpointId ?? null, daily: endpointId === "endpoint_2" ? usageOverview.daily.map((day) => ({ ...day, requests: 0, tokens: 0, cost: 0 })) : usageOverview.daily, trendTotals: endpointId === "endpoint_2" ? { requests: 0, tokens: 0, cost: 0 } : usageOverview.trendTotals }; };
    apiClient.alerts = async () => alertTypes.map((type, index) => ({ id: `alert_${index}`, projectId, type, status: "active", deliveryStatus: "delivered", createdAt: policy.createdAt, updatedAt: policy.updatedAt, resolvedAt: null, dismissedAt: null }));
    apiClient.projectCapabilities = async () => capabilities;
    try {
      const usageView = render(<UsagePage projectId={projectId} />);
      assert.ok(screen.getByText("Loading usage..."));
      await screen.findByText("Project limits");
      await screen.findByText("2.0 KiB");
      for (const label of ["Active tasks", "Provider requests", "Provider tokens", "Provider cost", "Project file storage"]) assert.ok(screen.getByText(label));
      assert.ok(screen.getByText(/Your settled provider requests/));
      assert.ok(screen.getByRole("combobox", { name: "Usage scope endpoint" }));
      assert.equal(screen.queryByRole("combobox", { name: "Usage endpoint" }), null);
      fireEvent.click(screen.getByRole("combobox", { name: "Usage scope endpoint" }));
      fireEvent.click(await screen.findByRole("option", { name: "Secondary" }));
      await screen.findByText("No settled provider usage in this period.");
      assert.deepEqual(usageCalls, [undefined, "endpoint_2"]);
      usageView.unmount();
      render(<AlertsPage projectId={projectId} />);
      await screen.findByText("Sandbox failure");
      assert.equal(screen.getAllByText(/active/i).length >= alertTypes.length, true);
    } finally { restoreClient(original); }
  });

  it("filters audit events, opens a safe detail view, and never renders unsupported sensitive event fields", async () => {
    const original = snapshotClient();
    const event = { id: "audit_1", projectId, actorId: "user_1", actorDisplayName: "Ada Admin", actorEmail: "ada@example.test", action: "alert.resolve", status: "accepted" as const, resourceKind: "alert" as const, resourceId: "alert_1", createdAt: policy.createdAt, payload: { prompt: "do not render", credential: "supersecret" } } as ProjectAuditEvent;
    const queries: Array<Record<string, string | number | undefined>> = [];
    apiClient.audit = async (_projectId, query = {}) => { queries.push(query); return { items: [event], nextCursor: null }; };
    try {
      window.history.pushState({}, "", "/workspaces/workspace_1/projects/project_1/audit?resourceKind=alert&resourceId=alert_1");
      render(<AuditPage projectId={projectId} />);
      await screen.findByText(/Showing events for alert instance/);
      await waitFor(() => assert.equal(queries.at(-1)?.resourceKind, "alert"));
      fireEvent.click(screen.getByRole("combobox", { name: "Action" }));
      assert.ok(await screen.findByRole("option", { name: "chat.message.send" }));
      fireEvent.click(screen.getByRole("option", { name: "All actions" }));
      const row = await screen.findByRole("button", { name: /alert.resolve/ });
      fireEvent.click(row);
      await screen.findByRole("heading", { name: "Audit event detail" });
      assert.ok(screen.getByText("Only allowlisted operation fields are available."));
      assert.ok(screen.getAllByText("Ada Admin").length > 0);
      assert.equal(screen.queryByText("do not render"), null);
      assert.equal(screen.queryByText("supersecret"), null);
    } finally { window.history.pushState({}, "", "/"); restoreClient(original); }
  });

  it("uses project alert history for the Notifications tab and only allows projected managers to resolve it", async () => {
    const original = snapshotClient();
    const alert: ProjectAlert = { id: "history_1", projectId, type: "task_failure", status: "active", deliveryStatus: "delivered", endpointId: "endpoint_1", createdAt: policy.createdAt, updatedAt: policy.updatedAt, resolvedAt: null, dismissedAt: null };
    const transitions: string[] = [];
    apiClient.alerts = async () => [alert];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.transitionAlert = async (_projectId, alertId, status) => { transitions.push(`${alertId}:${status}`); return { ...alert, status, resolvedAt: policy.updatedAt, updatedAt: policy.updatedAt }; };
    try {
      window.history.pushState({}, "", "/workspaces/workspace_1/projects/project_1/alerts?alertId=history_1");
      render(<AlertsPage projectId={projectId} />);
      await screen.findByText("Task failure");
      assert.ok(screen.getByText("Linked instance"));
      assert.equal(screen.getByRole("link", { name: "Investigate usage" }).getAttribute("href"), "usage?endpointId=endpoint_1");
      assert.equal(screen.getByRole("link", { name: "View related audit" }).getAttribute("href"), "audit?resourceKind=alert&resourceId=history_1");
      fireEvent.click(screen.getByRole("button", { name: "Resolve alert" }));
      await waitFor(() => assert.deepEqual(transitions, ["history_1:resolved"]));
      assert.ok(screen.getByText("resolved"));
    } finally { window.history.pushState({}, "", "/"); restoreClient(original); apiClient.transitionAlert = original.transitionAlert; }
  });

  it("filters alert history and keeps a failed resolve in the ready state without rejecting the click handler", async () => {
    const original = snapshotClient();
    const active: ProjectAlert = { id: "active_1", projectId, type: "task_failure", status: "active", deliveryStatus: "delivered", createdAt: policy.createdAt, updatedAt: policy.updatedAt, resolvedAt: null, dismissedAt: null };
    const resolved: ProjectAlert = { ...active, id: "resolved_1", type: "provider_failure", status: "resolved", resolvedAt: policy.updatedAt };
    apiClient.alerts = async () => [active, resolved];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.transitionAlert = async () => { throw new ApiError(500, "transition unavailable"); };
    try {
      render(<AlertsPage projectId={projectId} />);
      await screen.findByText("Task failure");
      fireEvent.click(screen.getByRole("combobox", { name: "Alert status" }));
      fireEvent.click(await screen.findByRole("option", { name: "Resolved" }));
      assert.equal(screen.queryByText("Task failure"), null);
      assert.ok(screen.getByText("Provider failure"));
      fireEvent.click(screen.getByRole("combobox", { name: "Alert status" }));
      fireEvent.click(await screen.findByRole("option", { name: "Active" }));
      fireEvent.click(screen.getByRole("button", { name: "Resolve alert" }));
      await screen.findByText("transition unavailable");
      assert.ok(screen.getAllByText("Task failure").length > 0);
      assert.equal(screen.queryByRole("heading", { name: "Alerts unavailable" }), null);
    } finally { restoreClient(original); }
  });
});

const alertTypes: ProjectAlert["type"][] = ["active_tasks_limit", "provider_requests_limit", "provider_tokens_limit", "provider_cost_limit", "project_file_bytes_limit", "endpoint_failure", "provider_failure", "task_failure", "sandbox_failure"];

function snapshotClient() { return { policy: apiClient.policy, updatePolicy: apiClient.updatePolicy, usage: apiClient.usage, alerts: apiClient.alerts, audit: apiClient.audit, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities, transitionAlert: apiClient.transitionAlert, alertRules: apiClient.alertRules }; }
function restoreClient(original: ReturnType<typeof snapshotClient>) { apiClient.policy = original.policy; apiClient.updatePolicy = original.updatePolicy; apiClient.usage = original.usage; apiClient.alerts = original.alerts; apiClient.audit = original.audit; apiClient.endpoints = original.endpoints; apiClient.projectCapabilities = original.projectCapabilities; apiClient.transitionAlert = original.transitionAlert; apiClient.alertRules = original.alertRules; }
function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, FormData: dom.window.FormData, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {} });
  Object.assign(globalThis, { requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number, cancelAnimationFrame: (id: number) => clearTimeout(id) });
  Object.assign(dom.window, { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
