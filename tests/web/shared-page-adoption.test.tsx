import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  self: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

const React = await import("react");
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { ProjectsTable } = await import("../../src/components/projects/ProjectsTable.js");
const { ResourceRouteLoading } = await import("../../src/components/resources/ResourceRouteState.js");

test.afterEach(() => cleanup());

test("projects use the shared searchable data table and retain pagination", () => {
  const projects = Array.from({ length: 21 }, (_, index) => ({
    id: `project-${index + 1}`,
    name: index === 20 ? "Needle" : `Project ${index + 1}`,
    taskConcurrencyLimit: 1,
    createdAt: "2026-01-01T00:00:00.000Z"
  }));
  render(<ProjectsTable workspaceId="workspace-1" projects={projects} />);
  assert.equal(screen.getAllByTestId("projects-table__row").length, 20);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  assert.equal(screen.getByTestId("projects-table__row").textContent?.includes("Needle"), true);
  fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "Needle" } });
  assert.equal(screen.getAllByTestId("projects-table__row").length, 1);
});

test("resource route loading uses the common page state and loading primitive", () => {
  render(<ResourceRouteLoading label="usage" />);
  assert.ok(screen.getByTestId("page-state__loading"));
  assert.equal(screen.getByRole("status").textContent?.includes("Loading"), true);
});
