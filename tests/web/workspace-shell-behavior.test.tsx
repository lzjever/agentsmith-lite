import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import type { Project, Workspace } from "../../src/lib/api/client.js";

installDom();

const { fireEvent, cleanup, render, waitFor } = await import("@testing-library/react");
const React = (await import("react")).default;
const { useState } = await import("react");
const { ProjectSwitcher } = await import("../../src/components/app-shell/Topbar.js");
const { ShellNavigation } = await import("../../src/components/app-shell/Sidebar.js");
const { ThemeToggle } = await import("../../src/components/theme/ThemeToggle.js");
const { TooltipProvider } = await import("../../src/components/ui/tooltip.js");
const { CreateProjectDialog } = await import("../../src/components/projects/CreateProjectDialog.js");
const { ApiError, apiClient } = await import("../../src/lib/api/client.js");

const workspace: Workspace = {
  id: "ws_1",
  name: "Workspace",
  capabilities: { canCreateProject: true, canManageMembers: true },
  projects: [
    { id: "proj_1", workspaceId: "ws_1", name: "Current project", taskConcurrencyLimit: 2, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" },
    { id: "proj_2", workspaceId: "ws_1", name: "Second project", taskConcurrencyLimit: 2, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }
  ],
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z"
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.dataset.theme = "light";
});

describe("workspace and shell interactions", () => {
  it("creates a project through the Lite API and closes with the created record", async () => {
    const original = apiClient.createProject;
    const created = { ...workspace.projects[1]!, id: "proj_new", name: "New project" };
    const opened: boolean[] = [];
    const received: Project[] = [];
    apiClient.createProject = async () => created;
    try {
      const view = render(<CreateProjectDialog workspaceId={workspace.id} open onOpenChange={(open) => opened.push(open)} onCreated={(project) => received.push(project)} />);
      fireEvent.change(await view.findByLabelText("Project name"), { target: { value: "New project" } });
      fireEvent.click(view.getByRole("button", { name: "Create project" }));
      await waitFor(() => assert.deepEqual(received, [created]));
      assert.deepEqual(opened, []);
    } finally {
      apiClient.createProject = original;
    }
  });

  it("keeps the dialog accessible, focuses its form, handles Escape, and shows create failures", async () => {
    const original = apiClient.createProject;
    apiClient.createProject = async () => { throw new ApiError(409, "Project name is unavailable"); };
    try {
      const view = render(<ProjectDialogHarness />);
      const dialog = await view.findByRole("dialog", { name: "New project" });
      await waitFor(() => assert.equal(dialog.contains(document.activeElement), true));
      fireEvent.change(view.getByLabelText("Project name"), { target: { value: "Taken" } });
      fireEvent.click(view.getByRole("button", { name: "Create project" }));
      await waitFor(() => assert.equal(view.getByRole("alert").textContent, "Project name is unavailable"));
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => assert.equal(view.queryByRole("dialog", { name: "New project" }), null));
    } finally {
      apiClient.createProject = original;
    }
  });

  it("selects projects from the mobile switcher and changes the mobile theme", async () => {
    const selected: string[] = [];
    const view = render(<><ProjectSwitcher workspace={workspace} project={workspace.projects[0]!} mobile onSelect={(projectId) => selected.push(projectId)} /><ThemeToggle mobile /></>);
    fireEvent.pointerDown(view.getByRole("button", { name: "Current project" }), { button: 0, ctrlKey: false });
    fireEvent.click(await view.findByRole("menuitem", { name: "Second project" }));
    assert.deepEqual(selected, ["proj_2"]);
    fireEvent.click(view.getByRole("button", { name: "Dark" }));
    assert.equal(document.documentElement.dataset.theme, "dark");
    assert.equal(view.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed"), "true");
  });

  it("marks the active retained route and exposes its collapsed navigation label by tooltip", async () => {
    const view = render(<TooltipProvider><ShellNavigation workspace={workspace} project={workspace.projects[0]!} pathname="/workspaces/ws_1/projects/proj_1/tasks/task_1" collapsed /></TooltipProvider>);
    const tasks = view.getByRole("link", { name: "Tasks" });
    assert.equal(tasks.getAttribute("aria-current"), "page");
    fireEvent.pointerMove(tasks, { pointerType: "mouse" });
    await waitFor(() => assert.equal(view.getByRole("tooltip").textContent, "Tasks"), { timeout: 2000 });
  });
});

function ProjectDialogHarness() {
  const [open, setOpen] = useState(true);
  return <CreateProjectDialog workspaceId={workspace.id} open={open} onOpenChange={setOpen} onCreated={() => undefined} />;
}

function installDom(): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Document: dom.window.Document,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    self: dom.window,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  if (!("ResizeObserver" in globalThis)) {
    Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  }
}
