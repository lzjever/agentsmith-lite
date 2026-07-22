import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathParamsContext, PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import type { Project, Workspace } from "../../src/lib/api/client.js";

installDom();

const { act, fireEvent, cleanup, render, waitFor } = await import("@testing-library/react");
const React = (await import("react")).default;
const { useState } = await import("react");
const { ProjectSwitcher } = await import("../../src/components/app-shell/Topbar.js");
const { ShellNavigation } = await import("../../src/components/app-shell/Sidebar.js");
const { ThemeToggle } = await import("../../src/components/theme/ThemeToggle.js");
const { AppProviders } = await import("../../src/app/providers.js");
const { themeFromCookie } = await import("../../src/components/theme/theme.js");
const { CreateProjectDialog } = await import("../../src/components/projects/CreateProjectDialog.js");
const { AppShell } = await import("../../src/components/app-shell/AppShell.js");
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
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
  document.cookie = "agentsmith-theme=; Path=/; Max-Age=0";
  document.documentElement.dataset.theme = "light";
  setSystemDark(false);
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

  it("reuses a project creation key after an unknown network result", async () => {
    const original = apiClient.createProject;
    const created = { ...workspace.projects[1]!, id: "proj_replayed", name: "Replayed project" };
    const keys: string[] = [];
    let attempts = 0;
    apiClient.createProject = (async (_workspaceId: string, _input: { name: string }, key: string) => {
      keys.push(key);
      if (++attempts === 1) throw new Error("connection closed");
      return created;
    }) as typeof apiClient.createProject;
    try {
      const view = render(<CreateProjectDialog workspaceId={workspace.id} open onOpenChange={() => {}} onCreated={() => {}} />);
      fireEvent.change(await view.findByLabelText("Project name"), { target: { value: created.name } });
      fireEvent.click(view.getByRole("button", { name: "Create project" }));
      await view.findByRole("alert");
      fireEvent.click(view.getByRole("button", { name: "Create project" }));
      await waitFor(() => assert.equal(attempts, 2));
      assert.equal(keys[0], keys[1]);
      assert.ok(keys[0]);
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
      assert.equal((view.getByLabelText("Project name") as HTMLInputElement).maxLength, 160);
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
    const view = render(<AppProviders><ProjectSwitcher workspace={workspace} project={workspace.projects[0]!} mobile onSelect={(projectId) => selected.push(projectId)} onViewAll={() => selected.push("all")} /><ThemeToggle mobile /></AppProviders>);
    fireEvent.pointerDown(view.getByRole("button", { name: "Current project" }), { button: 0, ctrlKey: false });
    fireEvent.click(await view.findByRole("menuitem", { name: "Second project" }));
    assert.deepEqual(selected, ["proj_2"]);
    fireEvent.pointerDown(view.getByRole("button", { name: "Current project" }), { button: 0, ctrlKey: false });
    fireEvent.click(await view.findByRole("menuitem", { name: "View all projects" }));
    assert.deepEqual(selected, ["proj_2", "all"]);
    fireEvent.click(view.getByRole("button", { name: "Dark" }));
    assert.equal(document.documentElement.dataset.theme, "dark");
    assert.equal(view.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed"), "true");
  });

  it("keeps pinned projects first in the project switcher", async () => {
    const current = { ...workspace.projects[0]!, name: "Beta project", pinnedAt: null };
    const pinned = { ...workspace.projects[1]!, name: "Zulu project", pinnedAt: "2026-07-12T00:00:00.000Z" };
    const alpha = { ...workspace.projects[1]!, id: "proj_3", name: "Alpha project", pinnedAt: null };
    const orderedWorkspace = { ...workspace, projects: [current, pinned, alpha] };
    const view = render(<ProjectSwitcher workspace={orderedWorkspace} project={current} mobile onSelect={() => undefined} />);

    fireEvent.pointerDown(view.getByRole("button", { name: "Beta project" }), { button: 0, ctrlKey: false });
    const items = await view.findAllByRole("menuitem");
    assert.deepEqual(items.map((item) => item.textContent?.replace("Current", "").trim()), ["Zulu project", "Alpha project", "Beta project"]);
  });

  it("persists an explicit theme choice for server-rendered pages", async () => {
    const view = render(<AppProviders><ThemeToggle mobile /></AppProviders>);
    fireEvent.click(view.getByRole("button", { name: "Dark" }));
    assert.equal(document.documentElement.dataset.theme, "dark");
    assert.match(document.cookie, /agentsmith-theme=dark/);
  });

  it("keeps independently loaded content usable when workspace navigation fails", async () => {
    const original = { currentIdentity: apiClient.currentIdentity, workspaces: apiClient.workspaces, notifications: apiClient.notifications };
    apiClient.currentIdentity = async () => ({ user: { id: "user_1", email: "user@example.test" } });
    apiClient.workspaces = async () => { throw new ApiError(503, "Directory offline"); };
    apiClient.notifications = async () => [];
    try {
      renderShell(<p>Independent workspace content</p>, "/workspaces/ws_1", { workspace: "ws_1" }, "ws_1");
      await waitFor(() => assert.ok(document.body.textContent?.includes("Independent workspace content")));
      assert.ok(document.body.textContent?.includes("Workspace navigation is unavailable"));
    } finally { Object.assign(apiClient, original); }
  });

  it("shows a recovery path for a project under the wrong workspace URL", async () => {
    const original = { currentIdentity: apiClient.currentIdentity, workspaces: apiClient.workspaces, notifications: apiClient.notifications };
    const other = { ...workspace, id: "ws_2", name: "Other workspace", projects: [{ ...workspace.projects[0]!, workspaceId: "ws_2", id: "proj_other" }] };
    apiClient.currentIdentity = async () => ({ user: { id: "user_1", email: "user@example.test" } });
    apiClient.workspaces = async () => [workspace, other];
    apiClient.notifications = async () => [];
    try {
      renderShell(<p>Wrong child</p>, "/workspaces/ws_1/projects/proj_other/overview", { workspace: "ws_1", project: "proj_other" }, "ws_1");
      await waitFor(() => assert.ok(document.body.textContent?.includes("Project and workspace do not match")));
      const recovery = document.querySelector('a[href="/workspaces/ws_2/projects/proj_other/overview"]');
      assert.ok(recovery);
      assert.equal(document.body.textContent?.includes("Wrong child"), false);
    } finally { Object.assign(apiClient, original); }
  });

  it("does not let an old directory response replace the current workspace", async () => {
    const original = { currentIdentity: apiClient.currentIdentity, workspaces: apiClient.workspaces, notifications: apiClient.notifications };
    const second = { ...workspace, id: "ws_2", name: "Current workspace", projects: [] };
    let finishFirst: ((value: Workspace[]) => void) | undefined;
    let reads = 0;
    apiClient.currentIdentity = async () => ({ user: { id: "user_1", email: "user@example.test" } });
    apiClient.workspaces = async () => ++reads === 1 ? new Promise((resolve) => { finishFirst = resolve; }) : [second];
    apiClient.notifications = async () => [];
    try {
      const view = renderShell(<p>First content</p>, "/workspaces/ws_1", { workspace: "ws_1" }, "ws_1");
      await waitFor(() => assert.ok(finishFirst));
      view.rerender(shell(<p>Current content</p>, "/workspaces/ws_2", { workspace: "ws_2" }, "ws_2"));
      await waitFor(() => assert.ok(document.body.textContent?.includes("Current content")));
      assert.ok(document.body.textContent?.includes("Current workspace"));

      await act(async () => finishFirst!([workspace]));
      assert.ok(document.body.textContent?.includes("Current workspace"));
      assert.equal(document.body.textContent?.includes("Workspace unavailable"), false);
    } finally { Object.assign(apiClient, original); }
  });

  it("returns an expired session to OIDC sign in without losing the current route", async () => {
    const original = { currentIdentity: apiClient.currentIdentity, workspaces: apiClient.workspaces, notifications: apiClient.notifications };
    apiClient.currentIdentity = async () => ({ user: { id: "user_1", email: "user@example.test" } });
    apiClient.workspaces = async () => [workspace];
    apiClient.notifications = async () => [];
    window.history.replaceState({}, "", "/workspaces/ws_1/projects/proj_1/tasks?status=running#latest");
    try {
      const view = renderShell(<p>Active task content</p>, "/workspaces/ws_1/projects/proj_1/tasks", { workspace: "ws_1", project: "proj_1" }, "ws_1");
      await waitFor(() => assert.ok(document.body.textContent?.includes("Active task content")));

      act(() => window.dispatchEvent(new Event("agentsmith:session-expired")));

      const signIn = await view.findByRole("link", { name: "Sign in" });
      assert.equal(document.body.textContent?.includes("Active task content"), false);
      assert.equal(signIn.getAttribute("href"), "/api/v1/auth/oidc/start?returnTo=%2Fworkspaces%2Fws_1%2Fprojects%2Fproj_1%2Ftasks%3Fstatus%3Drunning%23latest");
    } finally {
      Object.assign(apiClient, original);
      window.history.replaceState({}, "", "/");
    }
  });

  it("keeps the full current route when opening Profile", async () => {
    const original = { currentIdentity: apiClient.currentIdentity, workspaces: apiClient.workspaces, notifications: apiClient.notifications };
    apiClient.currentIdentity = async () => ({ user: { id: "user_1", email: "user@example.test" } });
    apiClient.workspaces = async () => [workspace];
    apiClient.notifications = async () => [];
    window.history.replaceState({}, "", "/workspaces/ws_1/context?scope=workspace_personal");
    try {
      const view = renderShell(<p>Personal context</p>, "/workspaces/ws_1/context", { workspace: "ws_1" }, "ws_1");
      await waitFor(() => assert.ok(document.body.textContent?.includes("Personal context")));

      fireEvent.pointerDown(view.getByRole("button", { name: "Open account menu" }), { button: 0, ctrlKey: false });
      const profile = await view.findByRole("menuitem", { name: "Profile" });
      assert.equal(profile.getAttribute("href"), "/profile?returnTo=%2Fworkspaces%2Fws_1%2Fcontext%3Fscope%3Dworkspace_personal");
    } finally { Object.assign(apiClient, original); }
  });

  it("refreshes the shell directory after settings change", async () => {
    const original = { currentIdentity: apiClient.currentIdentity, workspaces: apiClient.workspaces, notifications: apiClient.notifications };
    let directory = [workspace];
    apiClient.currentIdentity = async () => ({ user: { id: "user_1", email: "user@example.test" } });
    apiClient.workspaces = async () => directory;
    apiClient.notifications = async () => [];
    try {
      const view = renderShell(<p>Project settings</p>, "/workspaces/ws_1/projects/proj_1/settings", { workspace: "ws_1", project: "proj_1" }, "ws_1");
      await view.findByText("Current project");

      directory = [{ ...workspace, projects: [{ ...workspace.projects[0]!, name: "Renamed project" }, workspace.projects[1]!] }];
      act(() => window.dispatchEvent(new Event("agentsmith:directory-changed")));

      await view.findByText("Renamed project");
      assert.equal(view.queryByText("Current project"), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("refreshes the shell identity after a profile change without unmounting the page", async () => {
    const original = { currentIdentity: apiClient.currentIdentity, workspaces: apiClient.workspaces, notifications: apiClient.notifications };
    let reads = 0;
    apiClient.currentIdentity = async () => ({ user: { id: "user_1", email: "user@example.test", displayName: ++reads === 1 ? "Old Owner" : "Updated Name" } });
    apiClient.workspaces = async () => [workspace];
    apiClient.notifications = async () => [];
    try {
      const view = renderShell(<DraftHarness />, "/workspaces/ws_1/projects/proj_1/settings", { workspace: "ws_1", project: "proj_1" }, "ws_1");
      const draft = await view.findByRole("textbox", { name: "Unsaved draft" }) as HTMLInputElement;
      fireEvent.change(draft, { target: { value: "Keep this work" } });
      assert.match(view.getByRole("button", { name: "Open account menu" }).textContent ?? "", /OO/);

      act(() => window.dispatchEvent(new Event("agentsmith:identity-changed")));

      await waitFor(() => assert.equal(reads, 2));
      assert.match(view.getByRole("button", { name: "Open account menu" }).textContent ?? "", /UN/);
      assert.equal(draft.value, "Keep this work");
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps the active page mounted during a directory refresh", async () => {
    const original = { currentIdentity: apiClient.currentIdentity, workspaces: apiClient.workspaces, notifications: apiClient.notifications };
    let finishRefresh!: (value: Workspace[]) => void;
    let reads = 0;
    apiClient.currentIdentity = async () => ({ user: { id: "user_1", email: "user@example.test" } });
    apiClient.workspaces = async () => {
      reads += 1;
      return reads === 1 ? [workspace] : new Promise((resolve) => { finishRefresh = resolve; });
    };
    apiClient.notifications = async () => [];
    try {
      const view = renderShell(<DraftHarness />, "/workspaces/ws_1/projects/proj_1/settings", { workspace: "ws_1", project: "proj_1" }, "ws_1");
      const draft = await view.findByRole("textbox", { name: "Unsaved draft" }) as HTMLInputElement;
      fireEvent.change(draft, { target: { value: "Keep this work" } });

      act(() => window.dispatchEvent(new Event("agentsmith:directory-changed")));
      await waitFor(() => assert.equal(reads, 2));

      await act(async () => finishRefresh([workspace]));
      assert.equal((view.getByRole("textbox", { name: "Unsaved draft" }) as HTMLInputElement).value, "Keep this work");
    } finally {
      finishRefresh?.([workspace]);
      Object.assign(apiClient, original);
    }
  });

  it("keeps known content mounted while the route requests a fresh directory", async () => {
    const original = { currentIdentity: apiClient.currentIdentity, workspaces: apiClient.workspaces, notifications: apiClient.notifications };
    let finishRefresh!: (value: Workspace[]) => void;
    let reads = 0;
    apiClient.currentIdentity = async () => ({ user: { id: "user_1", email: "user@example.test" } });
    apiClient.workspaces = async () => {
      reads += 1;
      return reads === 1 ? [workspace] : new Promise((resolve) => { finishRefresh = resolve; });
    };
    apiClient.notifications = async () => [];
    try {
      const view = renderShell(<DraftHarness />, "/workspaces/ws_1", { workspace: "ws_1" }, "ws_1");
      const draft = await view.findByRole("textbox", { name: "Unsaved draft" }) as HTMLInputElement;
      fireEvent.change(draft, { target: { value: "Keep this work" } });

      view.rerender(shell(<DraftHarness />, "/workspaces/ws_1/projects/proj_1/overview", { workspace: "ws_1", project: "proj_1" }, "ws_1"));
      await waitFor(() => assert.equal(reads, 2));
      assert.equal((view.getByRole("textbox", { name: "Unsaved draft" }) as HTMLInputElement).value, "Keep this work");

      await act(async () => finishRefresh([workspace]));
    } finally {
      finishRefresh?.([workspace]);
      Object.assign(apiClient, original);
    }
  });

  it("provides a skip link and a stable main content target", async () => {
    const original = { currentIdentity: apiClient.currentIdentity, workspaces: apiClient.workspaces, notifications: apiClient.notifications };
    apiClient.currentIdentity = async () => ({ user: { id: "user_1", email: "user@example.test" } });
    apiClient.workspaces = async () => [workspace];
    apiClient.notifications = async () => [];
    try {
      const view = renderShell(<h1>Project overview</h1>, "/workspaces/ws_1/projects/proj_1/overview", { workspace: "ws_1", project: "proj_1" }, "ws_1");
      const skip = await view.findByRole("link", { name: "Skip to content" });
      const main = document.querySelector('[role="main"]');
      assert.ok(main);
      assert.equal(skip.getAttribute("href"), `#${main.id}`);
    } finally { Object.assign(apiClient, original); }
  });

  it("renders the server-resolved cookie theme through the Astryx shell", async () => {
    const original = { currentIdentity: apiClient.currentIdentity, workspaces: apiClient.workspaces, notifications: apiClient.notifications };
    apiClient.currentIdentity = async () => ({ user: { id: "user_1", email: "user@example.test" } });
    apiClient.workspaces = async () => [workspace];
    apiClient.notifications = async () => [];
    try {
      const initialThemeMode = themeFromCookie("dark");
      const view = render(<AppProviders initialThemeMode={initialThemeMode}><AppRouterContext.Provider value={router()}><PathnameContext.Provider value="/workspaces/ws_1/projects/proj_1/overview"><PathParamsContext.Provider value={{ workspace: "ws_1", project: "proj_1" }}><AppShell workspaceId="ws_1"><h1>Project overview</h1></AppShell></PathParamsContext.Provider></PathnameContext.Provider></AppRouterContext.Provider></AppProviders>);
      await view.findByRole("main");
      const theme = document.querySelector<HTMLElement>("[data-astryx-theme]");
      assert.equal(theme?.dataset.theme, "dark");
    } finally { Object.assign(apiClient, original); }
  });

  it("closes mobile navigation explicitly and returns focus to its trigger", async () => {
    const original = { currentIdentity: apiClient.currentIdentity, workspaces: apiClient.workspaces, notifications: apiClient.notifications };
    apiClient.currentIdentity = async () => ({ user: { id: "user_1", email: "user@example.test" } });
    apiClient.workspaces = async () => [workspace];
    apiClient.notifications = async () => [];
    try {
      const view = renderShell(<p>Project content</p>, "/workspaces/ws_1/projects/proj_1/overview", { workspace: "ws_1", project: "proj_1" }, "ws_1");
      const trigger = await view.findByRole("button", { name: "Open navigation" });
      trigger.focus();
      fireEvent.click(trigger);
      const close = await view.findByRole("button", { name: "Close navigation" });
      fireEvent.click(close);
      await waitFor(() => assert.equal(view.queryByRole("button", { name: "Close navigation" }), null));
      assert.equal(document.activeElement, trigger);
    } finally { Object.assign(apiClient, original); }
  });

  it("marks the active retained route with an accessible navigation label", async () => {
    const view = render(<ShellNavigation workspace={workspace} project={workspace.projects[0]!} pathname="/workspaces/ws_1/projects/proj_1/tasks/task_1" collapsed />);
    const tasks = view.getByRole("link", { name: "Tasks" });
    assert.equal(tasks.getAttribute("aria-current"), "page");
  });
});

function ProjectDialogHarness() {
  const [open, setOpen] = useState(true);
  return <CreateProjectDialog workspaceId={workspace.id} open={open} onOpenChange={setOpen} onCreated={() => undefined} />;
}

function DraftHarness() {
  const [draft, setDraft] = useState("");
  return <label>Unsaved draft<input aria-label="Unsaved draft" value={draft} onChange={(event) => setDraft(event.target.value)} /></label>;
}

function renderShell(children: React.ReactNode, pathname: string, params: Record<string, string>, workspaceId?: string) {
  return render(shell(children, pathname, params, workspaceId));
}

function shell(children: React.ReactNode, pathname: string, params: Record<string, string>, workspaceId?: string) {
  return <AppProviders><AppRouterContext.Provider value={router()}><PathnameContext.Provider value={pathname}><PathParamsContext.Provider value={params}><AppShell {...(workspaceId ? { workspaceId } : {})}>{children}</AppShell></PathParamsContext.Provider></PathnameContext.Provider></AppRouterContext.Provider></AppProviders>;
}

function router() { return { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} }; }

let systemDark = false;
const themeListeners = new Set<(event: MediaQueryListEvent) => void>();
function setSystemDark(next: boolean) {
  systemDark = next;
  for (const listener of themeListeners) listener({ matches: next } as MediaQueryListEvent);
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
    requestAnimationFrame: (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => window.clearTimeout(handle),
    getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: () => ({ get matches() { return systemDark; }, media: "(prefers-color-scheme: dark)", onchange: null, addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => themeListeners.add(listener), removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => themeListeners.delete(listener), addListener() {}, removeListener() {}, dispatchEvent: () => true }) });
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  Object.assign(dom.window.HTMLDialogElement.prototype, {
    showModal() { this.open = true; },
    close() { this.open = false; this.dispatchEvent(new dom.window.Event("close")); }
  });
  if (!("ResizeObserver" in globalThis)) {
    Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  }
}
