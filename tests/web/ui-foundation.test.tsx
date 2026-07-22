import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  DocumentFragment: dom.window.DocumentFragment,
  Node: dom.window.Node,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver,
  HTMLFormElement: dom.window.HTMLFormElement,
  getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
dom.window.HTMLCanvasElement.prototype.getContext = () => null;
Object.defineProperty(dom.window, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: false,
    media: "",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  })
});

const React = await import("react");
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { createColumnHelper, getCoreRowModel, useReactTable } = await import("@tanstack/react-table");
const { Checkbox, ConfirmationDialog, DataTable, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsContent, TabsList, TabsTrigger, ToastContainer, toast } = await import("../../src/components/ui/index.js");
const { Badge, Button, EmptyState, Skeleton, Spinner } = await import("@astryxdesign/core");
const { AppProviders } = await import("../../src/app/providers.js");
const { PageState } = await import("../../src/components/layout/PageState.js");
const { PageHeader } = await import("../../src/components/layout/PageHeader.js");
const { default: TaskDetailLoading } = await import("../../src/app/workspaces/[workspace]/projects/[project]/tasks/[taskId]/loading.js");
const { default: TaskArtifactsLoading } = await import("../../src/app/workspaces/[workspace]/projects/[project]/tasks/[taskId]/artifacts/loading.js");
const { default: WorkspaceError } = await import("../../src/app/workspaces/[workspace]/error.js");

test.afterEach(() => cleanup());

test("shared page state preserves success and labels non-success states", () => {
  const { rerender } = render(<PageState><p>Ready content</p></PageState>);
  assert.equal(screen.getByTestId("page-state__success").textContent, "Ready content");
  rerender(<PageState state="empty"><p>Nothing here</p></PageState>);
  assert.equal(screen.getByTestId("page-state__empty").textContent, "Nothing here");
});

test("page framework uses one page-title baseline and a distinct compact workbench heading", () => {
  render(<PageHeader title="Projects" subtitle="Manage project access." />);
  const pageTitle = screen.getByRole("heading", { level: 1, name: "Projects" });
  assert.match(pageTitle.className, /type-display/);
  assert.equal(screen.getAllByRole("heading", { level: 1 }).length, 1);
});

test("page loading keeps a labelled local state instead of an unlabeled full-page spinner", () => {
  render(<AppProviders><PageState state="loading"><section className="flex min-h-48 items-center border-y border-subtle py-6" aria-busy="true"><Spinner size="sm" label="Loading projects..." /></section></PageState></AppProviders>);
  const status = screen.getByRole("status", { name: "Loading projects..." });
  const region = status.closest("section");
  assert.equal(region?.getAttribute("aria-busy"), "true");
  assert.match(region?.className ?? "", /min-h-48/);
  assert.equal(region?.className.includes("min-h-\[400px\]"), false);
});

test("task loading routes use Astryx labelled local loading states", () => {
  const { rerender } = render(<AppProviders><TaskDetailLoading /></AppProviders>);
  let status = screen.getByRole("status", { name: "Loading task..." });
  assert.equal(status.closest("section")?.getAttribute("aria-busy"), "true");
  assert.match(status.closest("section")?.className ?? "", /min-h-48/);
  rerender(<AppProviders><TaskArtifactsLoading /></AppProviders>);
  status = screen.getByRole("status", { name: "Loading artifacts..." });
  assert.equal(status.closest("section")?.getAttribute("aria-busy"), "true");
});

test("status primitives come directly from Astryx without changing the surrounding page semantics", () => {
  render(<AppProviders><Badge variant="success" label="Active" /><EmptyState title="No projects" description="Create a project to start." headingLevel={2} /><section aria-busy="true"><Skeleton width="100%" height={24} /><Spinner label="Loading projects..." /></section></AppProviders>);
  assert.ok(screen.getByText("Active"));
  assert.ok(screen.getByRole("heading", { level: 2, name: "No projects" }));
  assert.equal(screen.getByRole("status", { name: "Loading projects..." }).tagName, "SPAN");
});

test("route error recovery keeps a named action wired to Next reset", () => {
  let resets = 0;
  render(<AppProviders><WorkspaceError error={new Error("offline")} reset={() => { resets += 1; }} /></AppProviders>);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  assert.equal(resets, 1);
});

test("shared controls preserve Astryx action semantics and accessible binary state", () => {
  render(<AppProviders><Button label="Default" variant="secondary" /><Button label="Primary" variant="primary" /><Label htmlFor="checked"><Checkbox id="checked" defaultChecked />Checked</Label></AppProviders>);
  assert.equal(screen.getByRole("button", { name: "Default" }).getAttribute("data-variant"), "secondary");
  assert.equal(screen.getByRole("button", { name: "Primary" }).getAttribute("data-variant"), "primary");
  assert.equal(screen.getByRole("checkbox", { name: "Checked" }).getAttribute("checked") !== null, true);
});

test("tabs and select expose keyboard-accessible composite controls", async () => {
  render(<><Tabs defaultValue="one"><TabsList aria-label="Views"><TabsTrigger value="one">One</TabsTrigger><TabsTrigger value="two">Two</TabsTrigger></TabsList><TabsContent value="one">First panel</TabsContent><TabsContent value="two">Second panel</TabsContent></Tabs><Select defaultValue="member"><SelectTrigger aria-label="Role"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="member">Member</SelectItem><SelectItem value="viewer">Viewer</SelectItem></SelectContent></Select></>);
  const second = screen.getByRole("tab", { name: "Two" });
  fireEvent.keyDown(second, { key: "Enter" });
  assert.equal(screen.getByRole("tabpanel").textContent, "Second panel");
  fireEvent.click(screen.getByRole("combobox", { name: "Role" }));
  await waitFor(() => assert.ok(screen.getByRole("option", { name: "Viewer" })));
  fireEvent.click(screen.getByRole("option", { name: "Viewer" }));
  assert.equal(screen.getByRole("combobox", { name: "Role" }).textContent?.includes("Viewer"), true);
});

test("confirmation dialog keeps focus in an accessible alert dialog and settles async confirmation", async () => {
  let confirmed = false;
  render(<ConfirmationDialog title="Delete file?" description="This cannot be undone." confirmText="Delete" trigger={<button>Open delete</button>} onConfirm={async () => { confirmed = true; }} />);
  fireEvent.click(screen.getByRole("button", { name: "Open delete" }));
  const dialog = await screen.findByRole("alertdialog");
  assert.equal(dialog.textContent?.includes("Delete file?"), true);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => assert.equal(confirmed, true));
  await waitFor(() => assert.equal(screen.queryByRole("alertdialog"), null));
});

test("confirmation dialog keeps a rejected action and its recovery context together", async () => {
  render(<ConfirmationDialog title="Delete credential?" confirmText="Delete" trigger={<button>Open delete</button>} errorContext="Credential could not be deleted" onConfirm={async () => { throw new Error("Endpoints still reference it"); }} />);
  fireEvent.click(screen.getByRole("button", { name: "Open delete" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  const alert = await screen.findByRole("alert");
  assert.equal(alert.textContent, "Credential could not be deleted: Endpoints still reference it");
  assert.ok(screen.getByRole("alertdialog", { name: "Delete credential?" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Open delete" }));
  assert.equal(screen.queryByRole("alert"), null);
});

test("confirmation dialog cannot be dismissed while an action is pending", async () => {
  let rejectAction!: () => void;
  render(<ConfirmationDialog title="Delete project?" confirmText="Delete" trigger={<button>Open delete</button>} errorContext="Project could not be deleted" onConfirm={() => new Promise((_resolve, reject) => { rejectAction = () => reject(new Error("Cleanup is still pending")); })} />);
  fireEvent.click(screen.getByRole("button", { name: "Open delete" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() => assert.ok(rejectAction));
  fireEvent.keyDown(document, { key:"Escape" });
  assert.ok(screen.getByRole("alertdialog", { name:"Delete project?" }));
  await act(async () => rejectAction());
  assert.equal((await screen.findByRole("alert")).textContent, "Project could not be deleted: Cleanup is still pending");
});

test("toast container stays within 390px viewport gutters and announces feedback", async () => {
  render(<ToastContainer />);
  await act(async () => toast.success("Endpoint saved", 10_000));
  const notification = await screen.findByRole("status");
  assert.equal(notification.textContent?.includes("Endpoint saved"), true);
  assert.match(screen.getByLabelText("Notifications").className, /max-w-\[calc\(100vw-2rem\)\]/);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await waitFor(() => assert.equal(screen.queryByRole("status"), null));
});

test("data table keeps row activation behind its stable generic API", () => {
  type Row = { id: string; name: string };
  const column = createColumnHelper<Row>();
  const selected: string[] = [];
  function Example() {
    const table = useReactTable({ data: [{ id: "a", name: "Alpha" }], columns: [column.accessor("name", { header: "Name" })], getCoreRowModel: getCoreRowModel() });
    return <DataTable table={table} testId="example-table" onRowClick={(row) => selected.push(row.id)} />;
  }
  render(<Example />);
  fireEvent.click(screen.getByTestId("example-table__row"));
  fireEvent.keyDown(screen.getByTestId("example-table__row"), { key: "Enter" });
  assert.deepEqual(selected, ["a", "a"]);
});
