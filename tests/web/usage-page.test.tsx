import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { apiClient, type ProjectUsageOverview } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { UsagePage } = await import("../../src/components/resources/AuditUsagePage.js");

afterEach(() => cleanup());

const overview: ProjectUsageOverview = { projectId: "project_1", usage: { projectId: "project_1", activeTasks: 1, providerRequests: 4, providerTokens: 42, providerCost: 2.5, projectFileBytes: 1024, updatedAt: "2026-07-11T00:00:00.000Z" }, limits: [{ metric: "activeTasks", current: 1, limit: 2, remaining: 1, window: { kind: "current_gauge", resetAt: null } }, { metric: "providerRequests", current: 4, limit: 8, remaining: 4, window: { kind: "project_lifetime", startedAt: "2026-07-01T00:00:00.000Z", resetAt: null } }, { metric: "providerTokens", current: 42, limit: 100, remaining: 58, window: { kind: "project_lifetime", startedAt: "2026-07-01T00:00:00.000Z", resetAt: null } }, { metric: "providerCost", current: 2.5, limit: null, remaining: null, window: { kind: "project_lifetime", startedAt: "2026-07-01T00:00:00.000Z", resetAt: null } }, { metric: "projectFileBytes", current: 1024, limit: 2048, remaining: 1024, window: { kind: "current_gauge", resetAt: null } }], daily: Array.from({ length: 30 }, (_, index) => ({ date: `2026-07-${String(index + 1).padStart(2, "0")}`, requests: index === 29 ? 4 : 0, tokens: index === 29 ? 42 : 0, cost: index === 29 ? 2.5 : 0 })), trendTotals: { requests: 4, tokens: 42, cost: 2.5 }, endpoints: [{ endpointId: "endpoint_1", endpointName: "Primary", requests: 4, tokens: 42, cost: 2.5 }, { endpointId: "endpoint_2", endpointName: "Secondary", requests: 0, tokens: 0, cost: 0 }], selectedEndpointId: null };

describe("usage page", () => {
  it("renders server-computed limit cards and requests an endpoint-filtered trend", async () => {
    const original = apiClient.usage;
    const requested: Array<string | undefined> = [];
    apiClient.usage = async (_projectId, endpointId) => { requested.push(endpointId); return endpointId === "endpoint_2" ? { ...overview, selectedEndpointId: endpointId, daily: overview.daily.map((day) => ({ ...day, requests: 0, tokens: 0, cost: 0 })), trendTotals: { requests: 0, tokens: 0, cost: 0 } } : overview; };
    try {
      render(<UsagePage projectId="project_1" />);
      await screen.findByRole("heading", { name: "Project limits" });
      assert.ok(screen.getByText("58 remaining of 100"));
      assert.equal(screen.getAllByText("Current state").length, 2);
      assert.equal(screen.getAllByText(/Project lifetime/).length, 3);
      assert.equal(screen.queryByText("Current usage is measured for the project lifetime. It does not reset."), null);
      assert.ok(screen.getByLabelText("30-day request trend"));
      fireEvent.click(screen.getByRole("combobox", { name: "Usage endpoint" }));
      fireEvent.click(await screen.findByRole("option", { name: "Secondary" }));
      await screen.findByText("No settled provider usage in this period.");
      await waitFor(() => assert.deepEqual(requested, [undefined, "endpoint_2"]));
    } finally { apiClient.usage = original; }
  });
});

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, HTMLFormElement: dom.window.HTMLFormElement, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {} });
  Object.assign(globalThis, { requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number, cancelAnimationFrame: (id: number) => clearTimeout(id) });
  Object.assign(dom.window, { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
