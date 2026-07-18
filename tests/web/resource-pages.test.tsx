import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type Endpoint, type ProjectAlert, type ProjectAuditEvent, type ProjectCapabilities, type ProjectPolicyInput, type ProjectPolicyUpdate, type ProjectResourcePolicy, type ProjectResourceUsage, type ProjectUsageOverview } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { ResourcePolicyPage } = await import("../../src/components/resources/ResourcePolicyPage.js");
const { AlertsPage } = await import("../../src/components/resources/AlertsPage.js");
const { AuditPage, UsagePage } = await import("../../src/components/resources/AuditUsagePage.js");

const projectId = "project_1";
const policy: ProjectResourcePolicy = { projectId, activeTasksLimit: 2, providerRequestsLimit: 10, providerTokensLimit: null, providerCostLimit: 3.5, projectFileBytesLimit: 2048, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" };
const capabilities: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: false, canManagePolicy: true, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true };
const usage: ProjectResourceUsage = { projectId, activeTasks: 1, providerRequests: 4, providerTokens: 50, providerCost: 1.25, projectFileBytes: 2048, updatedAt: "2026-07-11T00:00:00.000Z" };
const usageOverview: ProjectUsageOverview = { projectId, usage, limits: [{ metric: "activeTasks", current: 1, limit: 2, remaining: 1, window: { kind: "current_gauge", resetAt: null } }, { metric: "providerRequests", current: 4, limit: 10, remaining: 6, window: { kind: "project_lifetime", startedAt: "2026-07-01T00:00:00.000Z", resetAt: null } }, { metric: "providerTokens", current: 50, limit: null, remaining: null, window: { kind: "project_lifetime", startedAt: "2026-07-01T00:00:00.000Z", resetAt: null } }, { metric: "providerCost", current: 1.25, limit: 3.5, remaining: 2.25, window: { kind: "project_lifetime", startedAt: "2026-07-01T00:00:00.000Z", resetAt: null } }, { metric: "projectFileBytes", current: 2048, limit: 2048, remaining: 0, window: { kind: "current_gauge", resetAt: null } }], daily: Array.from({ length: 30 }, (_, index) => ({ date: `2026-07-${String(index + 1).padStart(2, "0")}`, requests: index === 29 ? 4 : 0, tokens: index === 29 ? 50 : 0, cost: index === 29 ? 1.25 : 0 })), trendTotals: { requests: 4, tokens: 50, cost: 1.25 }, endpoints: [{ endpointId: "endpoint_1", endpointName: "Primary", requests: 4, tokens: 50, cost: 1.25 }, { endpointId: "endpoint_2", endpointName: "Secondary", requests: 0, tokens: 0, cost: 0 }], selectedEndpointId: null };
const endpoint: Endpoint = { id: "endpoint_1", projectId, name: "Primary", protocol: "openai_chat_completions", baseUrl: "https://provider.example/v1", model: "model", credentialId: "credential_1", capabilities: ["text"], requestTimeoutSecs: 30, hasCredentialRef: true, taskEligible: true, createdAt: policy.createdAt, updatedAt: policy.updatedAt };

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("project resource pages", () => {
  it("only saves a changed resource policy and becomes clean after success", async () => {
    const original = snapshotClient();
    const updates: ProjectPolicyUpdate[] = [];
    apiClient.policy = async () => policy;
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [];
    apiClient.updatePolicy = async (_projectId, input) => {
      updates.push(input);
      return { ...policy, ...input, updatedAt: "2026-07-12T00:00:00.000Z" };
    };
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      const save = await screen.findByRole("button", { name: "Save policy" }) as HTMLButtonElement;
      assert.equal(save.disabled, true);
      fireEvent.change(screen.getByRole("spinbutton", { name: "Active tasks" }), { target: { value: "3" } });
      assert.equal(save.disabled, false);
      fireEvent.click(save);
      await waitFor(() => assert.equal(updates.length, 1));
      assert.equal(updates[0]?.expectedUpdatedAt, policy.updatedAt);
      await waitFor(() => assert.equal(save.disabled, true));
    } finally { restoreClient(original); }
  });

  it("edits file storage in MiB while preserving bytes in the API", async () => {
    const original = snapshotClient();
    const updates: ProjectPolicyInput[] = [];
    apiClient.policy = async () => ({ ...policy, projectFileBytesLimit: 10 * 1024 * 1024 });
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [];
    apiClient.updatePolicy = async (_projectId, input) => {
      updates.push(input);
      return { ...policy, ...input, projectFileBytesLimit: input.projectFileBytesLimit ?? null };
    };
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      const storage = await screen.findByRole("spinbutton", { name: "Project file storage (MiB)" }) as HTMLInputElement;
      assert.equal(storage.value, "10");
      fireEvent.change(storage, { target: { value: "12" } });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await waitFor(() => assert.equal(updates.length, 1));
      assert.equal(updates[0]?.projectFileBytesLimit, 12 * 1024 * 1024);
      assert.ok(screen.getByText("Provider cost (USD)"));
    } finally { restoreClient(original); }
  });

  it("shows no rolling window until an endpoint limit is configured", async () => {
    const original = snapshotClient();
    apiClient.policy = async () => policy;
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [endpoint];
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      const limit = await screen.findByRole("spinbutton", { name: "Primary Requests limit" });
      const window = screen.getByRole("combobox", { name: "Primary Requests window" }) as HTMLSelectElement;
      assert.equal(window.value, "");
      assert.equal(window.disabled, true);
      assert.equal(window.options[0]?.text, "No window");
      assert.equal(window.options[0]?.value, "");
      assert.equal(window.options[0]?.disabled, true);

      fireEvent.change(limit, { target: { value: "5" } });
      assert.equal(window.value, "3600");
      assert.equal(window.disabled, false);

      fireEvent.change(limit, { target: { value: "" } });
      assert.equal(window.value, "");
      assert.equal(window.disabled, true);
    } finally { restoreClient(original); }
  });

  it("preserves a valid custom endpoint rolling window", async () => {
    const original = snapshotClient();
    const updates: ProjectPolicyInput[] = [];
    apiClient.policy = async () => ({ ...policy, endpointWindows: [{ endpointId: endpoint.id, metric: "providerRequests", limit: 5, windowSeconds: 120 }] });
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [endpoint];
    apiClient.updatePolicy = async (_projectId, input) => { updates.push(input); return { ...policy, ...input }; };
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      const window = await screen.findByRole("combobox", { name: "Primary Requests window" }) as HTMLSelectElement;
      assert.equal(window.value, "120");
      assert.equal(window.selectedOptions[0]?.text, "120 seconds");

      fireEvent.change(screen.getByRole("spinbutton", { name: "Active tasks" }), { target: { value: "3" } });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await waitFor(() => assert.equal(updates.length, 1));
      assert.equal("endpointWindows" in updates[0]!, false);
    } finally { restoreClient(original); }
  });

  it("reuses a resource policy key until the request changes", async () => {
    const original = snapshotClient();
    const keys: string[] = [];
    apiClient.policy = async () => policy;
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [];
    apiClient.updatePolicy = (async (_projectId: string, input: ProjectPolicyInput, key: string) => {
      keys.push(key);
      if (keys.length <= 2) throw new Error("connection closed");
      return { ...policy, ...input };
    }) as typeof apiClient.updatePolicy;
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      fireEvent.change(await screen.findByRole("spinbutton", { name: "Active tasks" }), { target: { value: "3" } });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await waitFor(() => assert.equal(keys.length, 1));
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await waitFor(() => assert.equal(keys.length, 2));
      assert.equal(keys[1], keys[0]);
      fireEvent.change(screen.getByRole("spinbutton", { name: "Active tasks" }), { target: { value: "4" } });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await waitFor(() => assert.equal(keys.length, 3));
      assert.notEqual(keys[2], keys[1]);
    } finally { restoreClient(original); }
  });

  it("keeps the newest resource policy refresh", async () => {
    const original = snapshotClient();
    const resolvers: Array<(value: ProjectResourcePolicy) => void> = [];
    apiClient.policy = async () => new Promise((resolve) => resolvers.push(resolve));
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [];
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      await waitFor(() => assert.equal(resolvers.length, 1));
      fireEvent.click(screen.getByRole("button", { name: "Refresh policy" }));
      await waitFor(() => assert.equal(resolvers.length, 2));
      await act(async () => resolvers[1]!({ ...policy, activeTasksLimit: 7 }));
      assert.equal((await screen.findByRole("spinbutton", { name: "Active tasks" }) as HTMLInputElement).value, "7");
      await act(async () => resolvers[0]!(policy));
      assert.equal((screen.getByRole("spinbutton", { name: "Active tasks" }) as HTMLInputElement).value, "7");
    } finally { restoreClient(original); }
  });

  it("does not apply a completed save after switching projects", async () => {
    const original = snapshotClient();
    let resolveSave: ((value: ProjectResourcePolicy) => void) | undefined;
    apiClient.policy = async (requestedProjectId) => ({ ...policy, projectId: requestedProjectId, activeTasksLimit: requestedProjectId === "project_1" ? 2 : 8 });
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [];
    apiClient.updatePolicy = async () => new Promise((resolve) => { resolveSave = resolve; });
    try {
      const view = render(<ResourcePolicyPage projectId="project_1" />);
      const activeTasks = await screen.findByRole("spinbutton", { name: "Active tasks" }) as HTMLInputElement;
      fireEvent.change(activeTasks, { target: { value: "5" } });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await waitFor(() => assert.ok(resolveSave));

      view.rerender(<ResourcePolicyPage projectId="project_2" />);
      await waitFor(() => assert.equal((screen.getByRole("spinbutton", { name: "Active tasks" }) as HTMLInputElement).value, "8"));
      await act(async () => resolveSave!({ ...policy, activeTasksLimit: 5 }));
      assert.equal((screen.getByRole("spinbutton", { name: "Active tasks" }) as HTMLInputElement).value, "8");
    } finally { restoreClient(original); }
  });

  it("does not allow a refresh to race an in-flight policy save", async () => {
    const original = snapshotClient();
    let policyReads = 0;
    let resolveSave!: (value: ProjectResourcePolicy) => void;
    apiClient.policy = async () => { policyReads += 1; return policy; };
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [];
    apiClient.updatePolicy = async () => new Promise((resolve) => { resolveSave = resolve; });
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      fireEvent.change(await screen.findByRole("spinbutton", { name: "Active tasks" }), { target: { value: "3" } });
      fireEvent.click(screen.getByRole("button", { name:"Save policy" }));
      await waitFor(() => assert.ok(resolveSave));
      const refresh = screen.getByRole("button", { name:"Refresh policy" }) as HTMLButtonElement;
      assert.equal(refresh.disabled, true);
      fireEvent.click(refresh);
      assert.equal(policyReads, 1);
      await act(async () => resolveSave(policy));
      await waitFor(() => assert.equal(refresh.disabled, false));
    } finally { restoreClient(original); }
  });

  it("locks policy fields while a save is in flight", async () => {
    const original = snapshotClient();
    let resolveSave!: (value: ProjectResourcePolicy) => void;
    apiClient.policy = async () => ({ ...policy, endpointWindows: [{ endpointId: endpoint.id, metric: "providerRequests", limit: 4, windowSeconds: 3600 }] });
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [endpoint];
    apiClient.updatePolicy = async () => new Promise((resolve) => { resolveSave = resolve; });
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      const activeTasks = await screen.findByRole("spinbutton", { name: "Active tasks" }) as HTMLInputElement;
      fireEvent.change(activeTasks, { target: { value: "3" } });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await waitFor(() => assert.ok(resolveSave));

      assert.equal(activeTasks.disabled, true);
      assert.equal((screen.getByRole("spinbutton", { name: "Primary Requests limit" }) as HTMLInputElement).disabled, true);
      assert.equal((screen.getByRole("combobox", { name: "Primary Requests window" }) as HTMLSelectElement).disabled, true);

      await act(async () => resolveSave({ ...policy, activeTasksLimit: 3 }));
    } finally { restoreClient(original); }
  });

  it("uses projected policy capability and patches only changed policy fields", async () => {
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
      assert.deepEqual(updates[0], { activeTasksLimit: 5, expectedUpdatedAt: policy.updatedAt });
    } finally { restoreClient(original); }
  });

  it("keeps policy read-only when the project is archived during a mutation", async () => {
    const original = snapshotClient();
    apiClient.policy = async () => policy;
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [];
    apiClient.updatePolicy = async () => { throw new ApiError(409, "Project is archived"); };
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      fireEvent.change(await screen.findByRole("spinbutton", { name: "Active tasks" }), { target: { value: "3" } });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await screen.findByRole("alert");
      assert.equal(screen.queryByRole("button", { name: "Save policy" }), null);
      assert.ok(screen.getByText("Read-only policy"));
    } finally { restoreClient(original); }
  });

  it("clears the resource policy when a save discovers project access was removed", async () => {
    const original = snapshotClient();
    let removed = false;
    apiClient.policy = async () => {
      if (removed) throw new ApiError(403, "Project access denied");
      return policy;
    };
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [];
    apiClient.updatePolicy = async () => { removed = true; throw new ApiError(403, "Project access denied"); };
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      fireEvent.change(await screen.findByRole("spinbutton", { name: "Active tasks" }), { target: { value: "3" } });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));

      await screen.findByRole("heading", { name: "Resource policy unavailable" });
      assert.equal(screen.queryByRole("spinbutton", { name: "Active tasks" }), null);
      assert.equal(screen.queryByText("Read-only policy"), null);
    } finally { restoreClient(original); }
  });

  it("keeps the resource policy readable when management access was removed", async () => {
    const original = snapshotClient();
    let capabilityReads = 0;
    apiClient.policy = async () => policy;
    apiClient.projectCapabilities = async () => ++capabilityReads === 1 ? capabilities : { ...capabilities, canManagePolicy: false };
    apiClient.endpoints = async () => [];
    apiClient.updatePolicy = async () => { throw new ApiError(403, "Policy management is not allowed"); };
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      fireEvent.change(await screen.findByRole("spinbutton", { name: "Active tasks" }), { target: { value: "3" } });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));

      await screen.findByText("Read-only policy");
      assert.ok(screen.getByText("Active tasks"));
      assert.equal(screen.queryByRole("spinbutton", { name: "Active tasks" }), null);
      assert.equal(screen.queryByRole("button", { name: "Save policy" }), null);
      assert.equal(capabilityReads, 2);
    } finally { restoreClient(original); }
  });

  it("keeps policy readable but read-only when permissions cannot be loaded", async () => {
    const original = snapshotClient();
    apiClient.policy = async () => policy;
    apiClient.projectCapabilities = async () => { throw new ApiError(503, "Permissions unavailable"); };
    apiClient.endpoints = async () => [];
    try {
      render(<ResourcePolicyPage projectId={projectId} />);
      await screen.findByText("Read-only policy");
      assert.match(screen.getByRole("alert").textContent ?? "", /read-only until refreshed/i);
      assert.equal(screen.queryByRole("heading", { name: "Resource policy unavailable" }), null);
      assert.equal(screen.queryByRole("button", { name: "Save policy" }), null);
    } finally { restoreClient(original); }
  });

  it("saves project limits when endpoints fail and refreshes endpoint fields after recovery", async () => {
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
      fireEvent.change(screen.getByRole("spinbutton", { name: "Active tasks" }), { target: { value: "6" } });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await waitFor(() => assert.equal(updates.length, 1));
      assert.equal(updates[0]?.activeTasksLimit, 6);
      assert.equal("endpointWindows" in updates[0]!, false);

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => assert.equal((screen.getByRole("spinbutton", { name: "Active tasks" }) as HTMLInputElement).value, "7"));
      assert.equal((screen.getByRole("spinbutton", { name: "Primary Requests limit" }) as HTMLInputElement).value, "9");
      assert.equal((screen.getByRole("combobox", { name: "Primary Requests window" }) as HTMLSelectElement).value, "86400");
      assert.equal(screen.getByRole("button", { name: "Save policy" }).hasAttribute("disabled"), true);
      fireEvent.change(screen.getByRole("spinbutton", { name: "Primary Requests limit" }), { target: { value: "10" } });
      fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
      await waitFor(() => assert.equal(updates.length, 2));
      assert.deepEqual(updates[1], { endpointWindows: [{ ...refreshed.endpointWindows[0]!, limit: 10 }], expectedUpdatedAt: refreshed.updatedAt });
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

  it("keeps the newest alert refresh", async () => {
    const original = snapshotClient();
    const active: ProjectAlert = { id: "alert_refresh", projectId, type: "task_failure", status: "active", deliveryStatus: "delivered", createdAt: policy.createdAt, updatedAt: policy.updatedAt, resolvedAt: null, dismissedAt: null };
    const resolvers: Array<(value: ProjectAlert[]) => void> = [];
    apiClient.alerts = async () => new Promise((resolve) => resolvers.push(resolve));
    apiClient.projectCapabilities = async () => capabilities;
    try {
      render(<AlertsPage projectId={projectId} />);
      await waitFor(() => assert.equal(resolvers.length, 1));
      fireEvent.click(screen.getByRole("button", { name: "Refresh alerts" }));
      await waitFor(() => assert.equal(resolvers.length, 2));
      await act(async () => resolvers[1]!([{ ...active, status: "resolved", resolvedAt: policy.updatedAt }]));
      await screen.findByText("resolved");
      await act(async () => resolvers[0]!([active]));
      assert.ok(screen.getByText("resolved"));
      assert.equal(screen.queryByText("active"), null);
    } finally { restoreClient(original); }
  });

  it("labels provider request alerts by their actual project or endpoint scope", async () => {
    const original = snapshotClient();
    const alert = (id: string, endpointId: string | null): ProjectAlert => ({ id, projectId, type:"provider_requests_limit", status:"active", deliveryStatus:"delivered", endpointId, createdAt:policy.createdAt, updatedAt:policy.updatedAt, resolvedAt:null, dismissedAt:null });
    apiClient.alerts = async () => [alert("alert_project", null), alert("alert_endpoint", "endpoint_1")];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [endpoint];
    try {
      render(<AlertsPage workspaceId="workspace_1" projectId={projectId} />);
      assert.ok(await screen.findByText("Project request limit reached"));
      assert.ok(screen.getByText("Endpoint request limit reached"));
      assert.equal(screen.getByRole("link", { name: "Primary" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/endpoints");
      assert.equal(screen.queryByText(/Endpoint endpoint_1/), null);
    } finally { restoreClient(original); }
  });

  it("routes each alert type to the operation that can investigate it", async () => {
    const original = snapshotClient();
    const alert = (id: string, type: ProjectAlert["type"], endpointId?: string): ProjectAlert => ({ id, projectId, type, status: "active", deliveryStatus: "delivered", ...(endpointId ? { endpointId } : {}), createdAt: policy.createdAt, updatedAt: policy.updatedAt, resolvedAt: null, dismissedAt: null });
    apiClient.alerts = async () => [
      alert("endpoint_failure", "endpoint_failure", endpoint.id),
      alert("provider_failure", "provider_failure", endpoint.id),
      alert("task_failure", "task_failure", endpoint.id),
      alert("sandbox_failure", "sandbox_failure")
    ];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.endpoints = async () => [endpoint];
    try {
      render(<AlertsPage workspaceId="workspace_1" projectId={projectId} />);
      await screen.findByText("Endpoint failure");
      assert.equal(screen.getByRole("link", { name: "Open endpoints" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/endpoints");
      assert.equal(screen.getByRole("link", { name: "View provider failures" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/audit?action=provider.request&status=rejected");
      assert.equal(screen.getByRole("link", { name: "View failed tasks" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/tasks?status=failed");
      assert.equal(screen.getByRole("link", { name: "View sandbox failures" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/audit?action=sandbox.failed&status=accepted");
      assert.equal(screen.getAllByRole("link", { name: "View alert history" }).length, 4);
    } finally { restoreClient(original); }
  });

  it("does not apply an alert update after switching projects", async () => {
    const original = snapshotClient();
    let resolveTransition: ((value: ProjectAlert) => void) | undefined;
    const projectAlert = (requestedProjectId: string): ProjectAlert => ({
      id: `alert_${requestedProjectId}`,
      projectId: requestedProjectId,
      type: requestedProjectId === "project_1" ? "task_failure" : "provider_failure",
      status: "active",
      deliveryStatus: "delivered",
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
      resolvedAt: null,
      dismissedAt: null,
    });
    apiClient.alerts = async (requestedProjectId) => [projectAlert(requestedProjectId)];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.transitionAlert = async () => new Promise((resolve) => { resolveTransition = resolve; });
    try {
      const view = render(<AlertsPage projectId="project_1" />);
      await screen.findByText("Task failure");
      fireEvent.click(screen.getByRole("button", { name: "Resolve alert" }));
      await waitFor(() => assert.ok(resolveTransition));

      view.rerender(<AlertsPage projectId="project_2" />);
      await screen.findByText("Provider failure");
      await act(async () => resolveTransition!({ ...projectAlert("project_1"), status: "resolved", resolvedAt: policy.updatedAt }));
      assert.ok(screen.getByText("Provider failure"));
      assert.equal(screen.queryByText("Task failure"), null);
    } finally { restoreClient(original); }
  });

  it("keeps alert instances readable but disables actions when permissions cannot be loaded", async () => {
    const original = snapshotClient();
    const alert: ProjectAlert = { id: "alert_1", projectId, type: "task_failure", status: "active", deliveryStatus: "delivered", createdAt: policy.createdAt, updatedAt: policy.updatedAt, resolvedAt: null, dismissedAt: null };
    apiClient.alerts = async () => [alert];
    apiClient.projectCapabilities = async () => { throw new ApiError(503, "Permissions unavailable"); };
    apiClient.alertRules = async () => [];
    try {
      render(<AlertsPage projectId={projectId} />);
      await screen.findByText("Task failure");
      assert.match(screen.getByRole("alert").textContent ?? "", /read-only until refreshed/i);
      assert.equal(screen.queryByRole("heading", { name: "Alerts unavailable" }), null);
      assert.equal(screen.queryByRole("button", { name: "Resolve alert" }), null);
      assert.ok(screen.getByRole("tab", { name: "Rules" }));
    } finally { restoreClient(original); }
  });

  it("fails closed when the project is archived during alert management", async () => {
    const original = snapshotClient();
    const alert: ProjectAlert = { id: "alert_denied", projectId, type: "task_failure", status: "active", deliveryStatus: "delivered", createdAt: policy.createdAt, updatedAt: policy.updatedAt, resolvedAt: null, dismissedAt: null };
    apiClient.alerts = async () => [alert];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.acknowledgeAlert = async () => { throw new ApiError(409, "Project is archived"); };
    try {
      render(<AlertsPage projectId={projectId} />);
      fireEvent.click(await screen.findByRole("button", { name: "Acknowledge alert" }));
      await screen.findByText("Alert management access changed. Alerts and rules are now read-only.");
      assert.equal(screen.queryByRole("button", { name: "Retry" }), null);
      assert.equal(screen.queryByRole("button", { name: "Acknowledge alert" }), null);
      assert.ok(screen.getByText("Task failure"));
    } finally { restoreClient(original); }
  });

  it("clears alert data when a mutation discovers project access was removed", async () => {
    const original = snapshotClient();
    const alert: ProjectAlert = { id: "alert_removed", projectId, type: "task_failure", status: "active", deliveryStatus: "delivered", createdAt: policy.createdAt, updatedAt: policy.updatedAt, resolvedAt: null, dismissedAt: null };
    let removed = false;
    apiClient.alerts = async () => {
      if (removed) throw new ApiError(403, "Project access denied");
      return [alert];
    };
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.acknowledgeAlert = async () => { removed = true; throw new ApiError(403, "Project access denied"); };
    try {
      render(<AlertsPage projectId={projectId} />);
      fireEvent.click(await screen.findByRole("button", { name: "Acknowledge alert" }));

      await screen.findByRole("heading", { name: "Alerts unavailable" });
      assert.equal(screen.queryByText("Task failure"), null);
      assert.equal(screen.queryByRole("tab", { name: "Rules" }), null);
    } finally { restoreClient(original); }
  });

  it("refreshes an alert instance that changed before acknowledgement", async () => {
    const original = snapshotClient();
    const active: ProjectAlert = { id:"alert_changed",projectId,type:"task_failure",status:"active",deliveryStatus:"delivered",createdAt:policy.createdAt,updatedAt:policy.updatedAt,resolvedAt:null,dismissedAt:null };
    let reads=0;
    apiClient.alerts=async()=>++reads===1?[active]:[{...active,status:"resolved",resolvedAt:policy.updatedAt}];
    apiClient.projectCapabilities=async()=>capabilities;
    apiClient.acknowledgeAlert=async()=>{throw new ApiError(404,"Active project alert not found");};
    try {
      render(<AlertsPage projectId={projectId}/>);
      fireEvent.click(await screen.findByRole("button",{name:"Acknowledge alert"}));
      await waitFor(()=>assert.equal(reads,2));
      assert.ok(screen.getByText("resolved"));
      assert.equal(screen.queryByRole("button",{name:"Retry"}),null);
    } finally { restoreClient(original); }
  });

  it("keeps alerts readable when management access was removed", async () => {
    const original = snapshotClient();
    const alert: ProjectAlert = { id: "alert_read_only", projectId, type: "task_failure", status: "active", deliveryStatus: "delivered", createdAt: policy.createdAt, updatedAt: policy.updatedAt, resolvedAt: null, dismissedAt: null };
    let capabilityReads = 0;
    apiClient.alerts = async () => [alert];
    apiClient.projectCapabilities = async () => ++capabilityReads === 1 ? capabilities : { ...capabilities, canManagePolicy: false };
    apiClient.acknowledgeAlert = async () => { throw new ApiError(403, "Alert management is not allowed"); };
    try {
      render(<AlertsPage projectId={projectId} />);
      fireEvent.click(await screen.findByRole("button", { name: "Acknowledge alert" }));

      await screen.findByText("Task failure");
      await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Acknowledge alert" }), null));
      assert.ok(screen.getByRole("tab", { name: "Rules" }));
      assert.equal(screen.queryByRole("heading", { name: "Alerts unavailable" }), null);
      assert.equal(capabilityReads, 2);
    } finally { restoreClient(original); }
  });

  it("revokes alert management when the project is archived during a rule mutation", async () => {
    const original = snapshotClient();
    const rule = { id: "rule_denied", projectId, alertType: "task_failure" as const, enabled: true, createdAt: policy.createdAt, updatedAt: policy.updatedAt };
    apiClient.alerts = async () => [];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.alertRules = async () => [rule];
    apiClient.endpoints = async () => [];
    apiClient.updateAlertRule = async () => { throw new ApiError(409, "Project is archived"); };
    try {
      render(<AlertsPage projectId={projectId} />);
      const rulesTab = await screen.findByRole("tab", { name: "Rules" });
      fireEvent.mouseDown(rulesTab, { button: 0 });
      fireEvent.click(rulesTab);
      fireEvent.click(await screen.findByRole("button", { name: "Enabled" }));
      await screen.findByText("Alert management access changed. Alerts and rules are now read-only.");
      assert.equal(screen.queryByRole("button", { name: "Add rule" }), null);
      assert.equal(screen.queryByRole("button", { name: "Enabled" }), null);
      assert.ok(screen.getByText("Read-only"));
    } finally { restoreClient(original); }
  });

  it("refreshes alert instances after a rule mutation evaluates on the server", async () => {
    const original = snapshotClient();
    const alert: ProjectAlert = { id: "alert_from_rule", projectId, type: "active_tasks_limit", status: "active", deliveryStatus: "delivered", ruleId: "rule_created", metric: "active_tasks", metricValue: 0, threshold: 0, endpointId: null, acknowledgedAt: null, acknowledgedBy: null, silencedUntil: null, createdAt: policy.createdAt, updatedAt: policy.updatedAt, resolvedAt: null, dismissedAt: null };
    let alertReads = 0;
    apiClient.alerts = async () => (++alertReads === 1 ? [] : [alert]);
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.alertRules = async () => [];
    apiClient.endpoints = async () => [];
    apiClient.createAlertRule = async (_projectId, input) => ({ id: "rule_created", projectId, name: input.name, alertType: input.alertType, metric: "active_tasks", condition: "greater_than_or_equal", threshold: input.threshold, windowSeconds: null, scope: { kind: "project" }, enabled: true, createdAt: policy.createdAt, updatedAt: policy.updatedAt });
    try {
      render(<AlertsPage projectId={projectId} />);
      const rulesTab = await screen.findByRole("tab", { name: "Rules" });
      fireEvent.mouseDown(rulesTab, { button: 0 });
      fireEvent.click(rulesTab);
      fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
      fireEvent.change(screen.getByRole("spinbutton", { name: "Threshold" }), { target: { value: "0" } });
      fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
      await screen.findByRole("tab", { name: "Instances (1 active)" });
      assert.equal(alertReads, 2);
    } finally { restoreClient(original); }
  });

  it("reuses an alert rule creation key until the request changes", async () => {
    const original = snapshotClient();
    const keys: string[] = [];
    let attempts = 0;
    apiClient.alerts = async () => [];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.alertRules = async () => [];
    apiClient.endpoints = async () => [];
    apiClient.createAlertRule = (async (_projectId: string, input: { name?: string; alertType: string; threshold?: number }, key: string) => { keys.push(key); if (++attempts <= 2) throw new Error("connection closed"); return { id: "rule_created", projectId, name: input.name, alertType: input.alertType, metric: "active_tasks", condition: "greater_than_or_equal", threshold: input.threshold, windowSeconds: null, scope: { kind: "project" }, enabled: true, createdAt: policy.createdAt, updatedAt: policy.updatedAt }; }) as typeof apiClient.createAlertRule;
    try {
      render(<AlertsPage projectId={projectId} />);
      const rulesTab = await screen.findByRole("tab", { name: "Rules" });
      fireEvent.mouseDown(rulesTab, { button: 0 });
      fireEvent.click(rulesTab);
      fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
      fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
      await waitFor(() => assert.equal(attempts, 1));
      fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
      await waitFor(() => assert.equal(attempts, 2));
      assert.ok(keys[0]);
      assert.equal(keys[1], keys[0]);
      fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "Retry rule updated" } });
      fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
      await waitFor(() => assert.equal(attempts, 3));
      assert.notEqual(keys[2], keys[1]);
    } finally { restoreClient(original); }
  });

  it("reuses the original silence request after an unknown network result", async () => {
    const original = snapshotClient();
    const alert: ProjectAlert = { id: "alert_silence_retry", projectId, type: "task_failure", status: "active", deliveryStatus: "delivered", silencedUntil: null, createdAt: policy.createdAt, updatedAt: policy.updatedAt, resolvedAt: null, dismissedAt: null };
    const attempts: Array<{ until: string | null; key: string }> = [];
    apiClient.alerts = async () => [alert];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.silenceAlert = (async (_projectId: string, _alertId: string, until: string | null, key: string) => {
      attempts.push({ until, key });
      if (attempts.length === 1) throw new Error("connection closed");
      return { ...alert, silencedUntil: until };
    }) as typeof apiClient.silenceAlert;
    try {
      render(<AlertsPage projectId={projectId} />);
      fireEvent.click(await screen.findByRole("button", { name: "Silence alert for one hour" }));
      fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
      await waitFor(() => assert.equal(attempts.length, 2));
      assert.deepEqual(attempts[1], attempts[0]);
    } finally { restoreClient(original); }
  });

  it("reuses an alert rule update key after an unknown network result", async () => {
    const original = snapshotClient();
    const rule = { id: "rule_update_retry", projectId, alertType: "task_failure" as const, enabled: true, createdAt: policy.createdAt, updatedAt: policy.updatedAt };
    const keys: string[] = [];
    apiClient.alerts = async () => [];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.alertRules = async () => [rule];
    apiClient.endpoints = async () => [];
    apiClient.updateAlertRule = (async (_projectId: string, _ruleId: string, _input: unknown, key: string) => {
      keys.push(key);
      if (keys.length === 1) throw new Error("connection closed");
      return { ...rule, enabled: false };
    }) as typeof apiClient.updateAlertRule;
    try {
      render(<AlertsPage projectId={projectId} />);
      const rulesTab = await screen.findByRole("tab", { name: "Rules" });
      fireEvent.mouseDown(rulesTab, { button: 0 });
      fireEvent.click(rulesTab);
      fireEvent.click(await screen.findByRole("button", { name: "Enabled" }));
      await waitFor(() => assert.equal(keys.length, 1));
      fireEvent.click(screen.getByRole("button", { name: "Enabled" }));
      await waitFor(() => assert.equal(keys.length, 2));
      assert.equal(keys[1], keys[0]);
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
      assert.ok(screen.getByText("Provider totals include conservative reservations when final delivery usage is unknown."));
      assert.equal((screen.getByLabelText("2026-07-01: 0 requests") as HTMLElement).style.height, "0%");
      assert.equal((screen.getByLabelText("2026-07-30: 4 requests") as HTMLElement).style.height, "100%");
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

  it("keeps the latest usage refresh when an older request finishes last", async () => {
    const original = snapshotClient();
    let secondaryReads = 0;
    let resolveOlder!: (value: ProjectUsageOverview) => void;
    const withRequests = (requests: number): ProjectUsageOverview => ({ ...usageOverview, selectedEndpointId: "endpoint_2", daily: usageOverview.daily.map((day, index) => ({ ...day, requests: index === 29 ? requests : 0 })), trendTotals: { ...usageOverview.trendTotals, requests } });
    apiClient.usage = async (_projectId, endpointId) => {
      if (!endpointId) return usageOverview;
      secondaryReads += 1;
      if (secondaryReads === 1) return new Promise((resolve) => { resolveOlder = resolve; });
      return withRequests(22);
    };
    try {
      render(<UsagePage projectId={projectId} />);
      await screen.findByText("Project limits");
      fireEvent.click(screen.getByRole("combobox", { name: "Usage scope endpoint" }));
      fireEvent.click(await screen.findByRole("option", { name: "Secondary" }));
      await waitFor(() => assert.equal(secondaryReads, 1));
      fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
      await screen.findByText("22");
      await act(async () => { resolveOlder(withRequests(11)); await Promise.resolve(); });
      assert.ok(screen.getByText("22"));
      assert.equal(screen.queryByText("11"), null);
    } finally { restoreClient(original); }
  });

  it("filters audit events, opens a safe detail view, and never renders unsupported sensitive event fields", async () => {
    const original = snapshotClient();
    const event = { id: "audit_1", projectId, actorId: "user_1", actorDisplayName: "Ada Admin", actorEmail: "ada@example.test", action: "alert.rule.delete", status: "accepted" as const, resourceKind: "alert" as const, resourceId: "alert_rule_1", createdAt: "2026-07-11T00:00:00.123Z", payload: { prompt: "do not render", credential: "supersecret" } } as ProjectAuditEvent;
    const queries: Array<Record<string, string | number | undefined>> = [];
    apiClient.audit = async (_projectId, query = {}) => { queries.push(query); return { items: [event], nextCursor: null }; };
    apiClient.members = async () => [{ projectId, userId: "user_1", role: "owner", displayName: "Ada Admin", email: "ada@example.test", createdAt: policy.createdAt, updatedAt: policy.updatedAt }];
    try {
      window.history.pushState({}, "", "/workspaces/workspace_1/projects/project_1/audit?resourceKind=alert&resourceId=alert_rule_1");
      render(<AuditPage projectId={projectId} />);
      await screen.findByText(/Showing events for alert rule/);
      await waitFor(() => assert.equal(queries.at(-1)?.resourceKind, "alert"));
      assert.equal(queries.at(-1)?.resourceId, "alert_rule_1");
      fireEvent.click(screen.getByRole("button", { name: "Clear resource filter" }));
      await waitFor(() => assert.equal(queries.at(-1)?.resourceId, undefined));
      assert.equal(new URL(window.location.href).searchParams.has("resourceId"), false);
      assert.ok(screen.getByText("Ada Admin", { selector: "span" }));
      fireEvent.click(screen.getByRole("combobox", { name: "Actor" }));
      fireEvent.click(await screen.findByRole("option", { name: "Ada Admin (ada@example.test)" }));
      await waitFor(() => assert.equal(queries.at(-1)?.actorId, "user_1"));
      assert.equal(new URL(window.location.href).searchParams.get("actorId"), "user_1");
      fireEvent.click(screen.getByRole("combobox", { name: "Action" }));
      assert.ok(await screen.findByRole("option", { name: "Sent chat message" }));
      fireEvent.click(screen.getByRole("option", { name: "All actions" }));
      const row = await screen.findByRole("button", { name: /alert.rule.delete/ });
      fireEvent.click(row);
      await screen.findByRole("heading", { name: "Audit event detail" });
      assert.ok(screen.getByText("Event metadata for this project activity."));
      assert.ok(screen.getAllByText("Deleted alert rule").length >= 2);
      assert.ok(screen.getByText("alert.rule.delete"));
      assert.ok(screen.getAllByText("Ada Admin").length > 0);
      assert.ok(screen.getByText(event.createdAt));
      assert.equal(screen.queryByText("do not render"), null);
      assert.equal(screen.queryByText("supersecret"), null);
    } finally { window.history.pushState({}, "", "/"); restoreClient(original); }
  });

  it("keeps linkable audit filters in the URL and visibly labels the time range", async () => {
    const original = snapshotClient();
    apiClient.audit = async () => ({ items: [], nextCursor: null });
    try {
      window.history.pushState({}, "", "/workspaces/workspace_1/projects/project_1/audit?action=provider.request&status=rejected&resourceKind=alert&resourceId=alert_1");
      render(<AuditPage projectId={projectId} />);
      await screen.findByText(/Showing events for alert instance/);
      await screen.findByText("No audit events match this query.");
      await waitFor(() => assert.match(screen.getByRole("combobox", { name: "Result" }).textContent ?? "", /Rejected/));

      assert.ok(screen.getByText("From"));
      assert.ok(screen.getByText("To"));
      assert.match(screen.getByLabelText("To timestamp").parentElement?.parentElement?.className ?? "", /xl:grid-cols-4/);

      fireEvent.click(screen.getByRole("combobox", { name: "Resource type" }));
      fireEvent.click(await screen.findByRole("option", { name: "Task", exact: true }));
      await waitFor(() => {
        const query = new URL(window.location.href).searchParams;
        assert.equal(query.get("resourceKind"), "task");
        assert.equal(query.has("resourceId"), false);
      });
      await screen.findByText("No audit events match this query.");

      fireEvent.click(screen.getByRole("combobox", { name: "Action" }));
      fireEvent.click(await screen.findByRole("option", { name: "Sent chat message" }));
      assert.equal(new URL(window.location.href).searchParams.get("action"), "chat.message.send");
      await screen.findByText("No audit events match this query.");

      fireEvent.click(screen.getByRole("combobox", { name: "Result" }));
      fireEvent.click(await screen.findByRole("option", { name: "Accepted" }));
      assert.equal(new URL(window.location.href).searchParams.get("status"), "accepted");
    } finally { window.history.pushState({}, "", "/"); restoreClient(original); }
  });

  it("closes a stale audit detail when a refresh loses project access", async () => {
    const original = snapshotClient();
    const event = { id: "audit_removed", projectId, actorId: "user_1", action: "task.create", status: "accepted" as const, resourceKind: "task" as const, resourceId: "task_1", createdAt: policy.createdAt } as ProjectAuditEvent;
    let reads = 0;
    apiClient.audit = async () => {
      reads += 1;
      if (reads === 1) return { items: [event], nextCursor: null };
      throw new ApiError(403, "Project access denied");
    };
    try {
      render(<AuditPage projectId={projectId} />);
      fireEvent.click(await screen.findByRole("button", { name: /task.create/ }));
      await screen.findByRole("heading", { name: "Audit event detail" });
      fireEvent.click(screen.getByRole("button", { name: "Refresh audit", hidden: true }));

      await screen.findByRole("heading", { name: "Audit unavailable" });
      assert.equal(screen.queryByRole("heading", { name: "Audit event detail" }), null);
    } finally { restoreClient(original); }
  });

  it("starts audit from default filters after switching projects", async () => {
    const original = snapshotClient();
    const calls: Array<{ projectId: string; query: Record<string, unknown> }> = [];
    apiClient.audit = async (requestedProjectId, query = {}) => { calls.push({ projectId: requestedProjectId, query }); return { items: [], nextCursor: null }; };
    try {
      const view = render(<AuditPage projectId="project_1" />);
      await waitFor(() => assert.ok(calls.some((call) => call.projectId === "project_1")));
      fireEvent.click(screen.getByRole("combobox", { name: "Result" }));
      fireEvent.click(await screen.findByRole("option", { name: "Rejected" }));
      fireEvent.change(screen.getByLabelText("From timestamp"), { target: { value: "2026-07-10T12:00" } });
      await waitFor(() => assert.ok(calls.some((call) => call.projectId === "project_1" && call.query.status === "rejected" && typeof call.query.from === "string")));

      window.history.pushState({}, "", "/workspaces/workspace_1/projects/project_2/audit");
      view.rerender(<AuditPage projectId="project_2" />);
      await waitFor(() => assert.ok(calls.some((call) => call.projectId === "project_2")));
      const projectTwo = calls.find((call) => call.projectId === "project_2")!;
      assert.equal(projectTwo.query.status, undefined);
      assert.equal(projectTwo.query.from, undefined);
    } finally { restoreClient(original); }
  });

  it("keeps the latest audit refresh when an older page finishes last", async () => {
    const original = snapshotClient();
    const auditEvent = (id: string, action: string): ProjectAuditEvent => ({ id, projectId, actorId: "user_1", action, status: "accepted", resourceKind: "alert", resourceId: id, createdAt: policy.createdAt } as ProjectAuditEvent);
    let reads = 0;
    let resolveOlder!: (value: { items: ProjectAuditEvent[]; nextCursor: string | null }) => void;
    apiClient.audit = async () => {
      reads += 1;
      if (reads === 1) return { items: [auditEvent("initial", "alert.acknowledge")], nextCursor: null };
      if (reads === 2) return new Promise((resolve) => { resolveOlder = resolve; });
      return { items: [auditEvent("latest", "alert.resolve")], nextCursor: null };
    };
    try {
      render(<AuditPage projectId={projectId} />);
      await screen.findByText("Acknowledged alert");
      fireEvent.click(screen.getByRole("button", { name: "Refresh audit" }));
      await waitFor(() => assert.equal(reads, 2));
      fireEvent.click(screen.getByRole("button", { name: "Refresh audit" }));
      await screen.findByText("Resolved alert");
      await act(async () => { resolveOlder({ items: [auditEvent("older", "alert.dismiss")], nextCursor: null }); await Promise.resolve(); });
      assert.ok(screen.getByText("Resolved alert"));
      assert.equal(screen.queryByText("Dismissed alert"), null);
    } finally { restoreClient(original); }
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
      render(<AlertsPage workspaceId="workspace_1" projectId={projectId} />);
      await screen.findByText("Task failure");
      assert.ok(screen.getByText("Linked instance"));
      assert.equal(screen.getByRole("link", { name: "View failed tasks" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/tasks?status=failed");
      assert.equal(screen.getByRole("link", { name: "View alert history" }).getAttribute("href"), "/workspaces/workspace_1/projects/project_1/audit?resourceKind=alert&resourceId=history_1");
      fireEvent.click(screen.getByRole("button", { name: "Resolve alert" }));
      await waitFor(() => assert.deepEqual(transitions, ["history_1:resolved"]));
      assert.ok(screen.getByText("resolved"));
    } finally { window.history.pushState({}, "", "/"); restoreClient(original); apiClient.transitionAlert = original.transitionAlert; }
  });

  it("removes an alert deep link when the instance is not in this project", async () => {
    const original = snapshotClient();
    const alert: ProjectAlert = { id: "available_1", projectId, type: "task_failure", status: "active", deliveryStatus: "delivered", createdAt: policy.createdAt, updatedAt: policy.updatedAt, resolvedAt: null, dismissedAt: null };
    apiClient.alerts = async () => [alert];
    apiClient.projectCapabilities = async () => capabilities;
    try {
      window.history.pushState({}, "", "/workspaces/workspace_1/projects/project_1/alerts?alertId=other_project_alert#instances");
      render(<AlertsPage projectId={projectId} />);
      await screen.findByText("Task failure");
      await waitFor(() => assert.equal(new URL(window.location.href).searchParams.has("alertId"), false));
      assert.equal(window.location.hash, "#instances");
      assert.equal(screen.queryByText("Linked instance"), null);
    } finally { window.history.pushState({}, "", "/"); restoreClient(original); }
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

function snapshotClient() { return { policy: apiClient.policy, updatePolicy: apiClient.updatePolicy, usage: apiClient.usage, alerts: apiClient.alerts, audit: apiClient.audit, endpoints: apiClient.endpoints, projectCapabilities: apiClient.projectCapabilities, transitionAlert: apiClient.transitionAlert, acknowledgeAlert: apiClient.acknowledgeAlert, silenceAlert: apiClient.silenceAlert, alertRules: apiClient.alertRules, createAlertRule: apiClient.createAlertRule, updateAlertRule: apiClient.updateAlertRule, deleteAlertRule: apiClient.deleteAlertRule, testAlertRule: apiClient.testAlertRule }; }
function restoreClient(original: ReturnType<typeof snapshotClient>) { Object.assign(apiClient, original); }
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
