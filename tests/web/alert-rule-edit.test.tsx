import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { apiClient, type ProjectAlertRule } from "../../src/lib/api/client.js";
import { toast } from "../../src/components/ui/toast.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { AlertRulesPanel } = await import("../../src/components/alerts/AlertRulesPanel.js");

const projectId = "project_1";
const timestamps = { createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" };
const existing: ProjectAlertRule = { id: "rule_1", projectId, alertType: "task_failure", enabled: true, ...timestamps };

afterEach(() => cleanup());

describe("alert rule editing", () => {
  it("creates a rule through the shared form dialog", async () => {
    const original = snapshotClient();
    const creates: Array<{ alertType: string; enabled?: boolean }> = [];
    apiClient.alertRules = async () => [];
    apiClient.createAlertRule = async (_projectId, input) => {
      creates.push(input);
      return { ...existing, id: "rule_created", alertType: input.alertType, enabled: input.enabled ?? true };
    };
    try {
      render(<AlertRulesPanel projectId={projectId} canManage />);
      await screen.findByText("No alert rules configured.");
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
      await screen.findByRole("heading", { name: "Create alert rule" });
      fireEvent.click(screen.getByRole("button", { name: "Create rule" }));
      await waitFor(() => assert.deepEqual(creates, [{ name:"Task capacity",alertType: "active_tasks_limit",metric:"active_tasks",threshold:1,windowSeconds:null,scope:{kind:"project"}, enabled: true }]));
      await screen.findByText("Task capacity");
    } finally {
      restoreClient(original);
    }
  });

  it("edits the existing alert type and enabled state through PATCH", async () => {
    const original = snapshotClient();
    const updates: Array<{ projectId: string; ruleId: string; input: { alertType?: string; enabled?: boolean } }> = [];
    const successes: string[] = [];
    apiClient.alertRules = async () => [existing];
    apiClient.updateAlertRule = async (nextProjectId, ruleId, input) => {
      updates.push({ projectId: nextProjectId, ruleId, input });
      return { ...existing, ...input, updatedAt: "2026-07-12T00:00:00.000Z" };
    };
    toast.success = (message) => { successes.push(message); };
    try {
      render(<AlertRulesPanel projectId={projectId} canManage />);
      assert.ok(screen.getByText("Loading alert rules..."));
      await screen.findByText("Task failure");

      fireEvent.click(screen.getByRole("button", { name: "Edit alert rule" }));
      await screen.findByRole("heading", { name: "Edit alert rule" });
      const nativeSelect = document.querySelector("select");
      assert.ok(nativeSelect, "Radix Select should render its native form bridge");
      fireEvent.change(nativeSelect, { target: { value: "provider_requests_limit" } });
      assert.equal((screen.getByRole("textbox", { name: "Metric" }) as HTMLInputElement).value, "provider requests");
      assert.ok(screen.getByRole("combobox", { name: "Evaluation window" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Enabled" }));
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => assert.equal(updates.length, 1));
      assert.deepEqual(updates[0], { projectId, ruleId: existing.id, input: { name:"Task failure",alertType: "provider_requests_limit",metric:"provider_requests",threshold:1,windowSeconds:null,scope:{kind:"project"}, enabled: false } });
      await screen.findByText("Task failure");
      assert.ok(screen.getByText("Disabled"));
      assert.deepEqual(successes, ["Alert rule updated."]);
      assert.equal(screen.queryByRole("heading", { name: "Edit alert rule" }), null);
    } finally {
      restoreClient(original);
    }
  });

  it("keeps a failed edit in context and allows a clear retry", async () => {
    const original = snapshotClient();
    const errors: string[] = [];
    let attempts = 0;
    apiClient.alertRules = async () => [existing];
    apiClient.updateAlertRule = async (_projectId, _ruleId, input) => {
      attempts += 1;
      if (attempts === 1) throw new Error("forbidden");
      return { ...existing, ...input };
    };
    toast.error = (message) => { errors.push(message); };
    try {
      render(<AlertRulesPanel projectId={projectId} canManage />);
      await screen.findByText("Task failure");
      fireEvent.click(screen.getByRole("button", { name: "Edit alert rule" }));
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await screen.findByRole("alert");
      assert.ok(screen.getByText("Alert rule could not be updated."));
      assert.ok(screen.getByRole("heading", { name: "Edit alert rule" }));
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => assert.equal(attempts, 2));
      await waitFor(() => assert.equal(screen.queryByRole("heading", { name: "Edit alert rule" }), null));
      assert.deepEqual(errors, ["Alert rule could not be updated."]);
    } finally {
      restoreClient(original);
    }
  });

  it("keeps read-only rules non-mutating and recovers a failed list read", async () => {
    const original = snapshotClient();
    let reads = 0;
    apiClient.alertRules = async () => {
      reads += 1;
      if (reads === 1) throw new Error("unavailable");
      return [existing];
    };
    try {
      render(<AlertRulesPanel projectId={projectId} canManage={false} />);
      await screen.findByRole("alert");
      assert.equal(screen.queryByText("No alert rules configured."), null);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("Task failure");
      assert.ok(screen.getByText("Read-only"));
      assert.equal(screen.queryByRole("button", { name: "Add rule" }), null);
      assert.equal(screen.queryByRole("button", { name: "Edit alert rule" }), null);
      assert.equal(screen.queryByRole("button", { name: "Delete alert rule" }), null);
      assert.equal(screen.queryByRole("button", { name: "Enabled" }), null);
      assert.ok(screen.getByText("Enabled"));
    } finally {
      restoreClient(original);
    }
  });

  it("reports whether a rule would trigger instead of claiming every test matched", async () => {
    const original = snapshotClient();
    const successes: string[] = [];
    apiClient.alertRules = async () => [existing];
    apiClient.testAlertRule = async () => ({ matched: false, metric: "failure_count", value: 1, threshold: 2, evaluatedAt: "2026-07-12T00:00:00.000Z" });
    toast.success = (message) => { successes.push(message); };
    try {
      render(<AlertRulesPanel projectId={projectId} canManage />);
      await screen.findByText("Task failure");
      fireEvent.click(screen.getByRole("button", { name: "Test alert rule" }));
      await waitFor(() => assert.deepEqual(successes, ["Rule would not trigger: failure count is 1, threshold 2."]));
    } finally {
      restoreClient(original);
    }
  });
});

function snapshotClient() {
  return { alertRules: apiClient.alertRules, createAlertRule: apiClient.createAlertRule, updateAlertRule: apiClient.updateAlertRule, testAlertRule: apiClient.testAlertRule, success: toast.success, error: toast.error };
}

function restoreClient(original: ReturnType<typeof snapshotClient>) {
  apiClient.alertRules = original.alertRules;
  apiClient.createAlertRule = original.createAlertRule;
  apiClient.updateAlertRule = original.updateAlertRule;
  apiClient.testAlertRule = original.testAlertRule;
  toast.success = original.success;
  toast.error = original.error;
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLFormElement: dom.window.HTMLFormElement, HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, self: dom.window, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, { hasPointerCapture() { return false; }, setPointerCapture() {}, releasePointerCapture() {}, scrollIntoView() {} });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
