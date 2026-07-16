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

const React = await import("react");
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { createColumnHelper, getCoreRowModel, useReactTable } = await import("@tanstack/react-table");
const { Button, Checkbox, ConfirmationDialog, DataTable, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Tabs, TabsContent, TabsList, TabsTrigger, ToastContainer, toast } = await import("../../src/components/ui/index.js");
const { PageState } = await import("../../src/components/layout/PageState.js");

test.afterEach(() => cleanup());

test("shared page state preserves success and labels non-success states", () => {
  const { rerender } = render(<PageState><p>Ready content</p></PageState>);
  assert.equal(screen.getByTestId("page-state__success").textContent, "Ready content");
  rerender(<PageState state="empty"><p>Nothing here</p></PageState>);
  assert.equal(screen.getByTestId("page-state__empty").textContent, "Nothing here");
});

test("reference-derived controls preserve hierarchy and accessible binary state", () => {
  function Example() {
    const [enabled, setEnabled] = React.useState(false);
    return <><Button>Default</Button><Button variant="primary">Primary</Button><Label htmlFor="checked"><Checkbox id="checked" defaultChecked />Checked</Label><Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" /></>;
  }
  render(<Example />);
  assert.match(screen.getByRole("button", { name: "Default" }).className, /bg-transparent/);
  assert.match(screen.getByRole("button", { name: "Primary" }).className, /bg-foreground/);
  assert.equal(screen.getByRole("checkbox", { name: "Checked" }).getAttribute("checked") !== null, true);
  const toggle = screen.getByRole("switch", { name: "Enabled" });
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute("aria-checked"), "true");
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
