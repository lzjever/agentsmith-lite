import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { apiClient, type ProjectCapabilities, type ProjectFile } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { DeleteFileDialog, ProjectFilesPage } = await import("../../src/components/files/ProjectFilesPage.js");

const file: ProjectFile = { name: "brief.txt", path: "files/brief.txt", type: "file", size: 12, updatedAt: "2026-07-11T00:00:00.000Z" };
const writable: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true };
const readOnly: ProjectCapabilities = { ...writable, canWriteFiles: false };

afterEach(() => cleanup());

describe("project files browser", () => {
  it("uploads one selected file and reloads the listing", async () => {
    const original = snapshotClient();
    let lists = 0;
    const uploaded: string[] = [];
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => ({ entries: ++lists === 1 ? [] : [file] });
    apiClient.uploadFile = async (_projectId, path) => {
      uploaded.push(path);
      return { path, bytes: 1 };
    };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "No files yet" });
      const input = document.querySelector('input[type="file"]')!;
      fireEvent.change(input, { target: { files: [new File(["a"], "brief.txt")] } });
      await waitFor(() => assert.deepEqual(uploaded, ["files/brief.txt"]));
      await waitFor(() => assert.equal(lists, 2));
      assert.ok(screen.getByText("brief.txt"));
    } finally { restoreClient(original); }
  });

  it("shows a failed upload inline with refresh", async () => {
    const original = snapshotClient();
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => ({ entries: [] });
    apiClient.uploadFile = async () => { throw new Error("brief.txt was rejected"); };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "No files yet" });
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "brief.txt")] } });
      const alert = await screen.findByRole("alert");
      assert.match(alert.textContent ?? "", /brief\.txt was rejected/);
      assert.ok(screen.getByRole("button", { name: "Retry upload" }));
      assert.ok(screen.getAllByRole("button", { name: "Refresh files" }).length > 1);
    } finally { restoreClient(original); }
  });

  it("retries the same failed file", async () => {
    const original = snapshotClient();
    let attempts = 0;
    const uploaded: string[] = [];
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => ({ entries: [] });
    apiClient.uploadFile = async (_projectId, path) => {
      attempts++;
      uploaded.push(path);
      if (attempts === 1) throw new Error("network unavailable");
      return { path, bytes: 1 };
    };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "No files yet" });
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "brief.txt")] } });
      await screen.findByRole("button", { name: "Retry upload" });
      fireEvent.click(screen.getByRole("button", { name: "Retry upload" }));
      await waitFor(() => assert.deepEqual(uploaded, ["files/brief.txt", "files/brief.txt"]));
      await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Retry upload" }), null));
    } finally { restoreClient(original); }
  });

  it("uses retry and a nested-folder empty state", async () => {
    const original = snapshotClient();
    let attempts = 0;
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async (_projectId, path) => { attempts++; if (attempts === 1) throw new Error("network unavailable"); return { entries: path === "files" ? [{ name: "reports", path: "files/reports", type: "directory", updatedAt: file.updatedAt }] : [] }; };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "Files unavailable" });
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await screen.findByText("reports");
      fireEvent.click(screen.getByRole("button", { name: "reports" }));
      await screen.findByRole("heading", { name: "This folder is empty" });
    } finally { restoreClient(original); }
  });

  it("keeps read-only actions hidden and presents mobile details", async () => {
    const original = snapshotClient();
    apiClient.files = async () => ({ entries: [file] });
    apiClient.projectCapabilities = async () => writable;
    try {
      const view = render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByText("brief.txt");
      fireEvent.click(screen.getByRole("button", { name: "brief.txt" }));
      await waitFor(() => assert.equal(screen.getByRole("button", { name: "File details" }).getAttribute("aria-expanded"), "true"));
      fireEvent.click(screen.getByRole("button", { name: "File details" }));
      assert.equal(screen.getByRole("button", { name: "File details" }).getAttribute("aria-expanded"), "false");
      view.unmount();
      apiClient.projectCapabilities = async () => readOnly;
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByText("brief.txt");
      assert.equal(screen.queryByRole("button", { name: "Upload" }), null);
      fireEvent.click(screen.getByRole("button", { name: "brief.txt" }));
      assert.equal(screen.queryByRole("button", { name: "Delete" }), null);
      assert.ok(screen.getAllByRole("link", { name: "Download" }).length > 0);
    } finally { restoreClient(original); }
  });

  it("focuses and closes the delete confirmation", async () => {
    render(<DeleteDialogHarness />);
    const dialog = await screen.findByRole("alertdialog", { name: "Delete file?" });
    await waitFor(() => assert.equal(document.activeElement, screen.getByRole("button", { name: "Cancel" })));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => assert.equal(screen.queryByRole("alertdialog", { name: "Delete file?" }), null));
  });

  it("filters locally and opens a bounded text preview", async () => {
    const original=snapshotClient(); const originalFetch=globalThis.fetch;
    apiClient.files=async()=>({entries:[file,{...file,name:"image.png",path:"files/image.png"}]});apiClient.projectCapabilities=async()=>writable;
    globalThis.fetch=async()=>new Response("preview",{headers:{"content-type":"text/plain"}});
    try{render(<ProjectFilesPage projectId="project_1"/>);await screen.findByText("brief.txt");const filter=screen.getByRole("textbox",{name:"Filter files"});assert.match(filter.className,/border-border-input/);fireEvent.change(filter,{target:{value:"image"}});assert.equal(screen.queryByText("brief.txt"),null);assert.ok(screen.getByText("image.png"));fireEvent.click(screen.getByRole("button",{name:"Clear file filter"}));fireEvent.click(screen.getByRole("button",{name:"brief.txt"}));fireEvent.click(screen.getAllByRole("button",{name:"Preview"})[0]!);await screen.findByText("preview");fireEvent.click(screen.getByRole("button",{name:"Close preview"}));}finally{restoreClient(original);globalThis.fetch=originalFetch;}
  });

  it("shows a distinct no-match state and clears the filter", async () => {
    const original = snapshotClient();
    apiClient.files = async () => ({ entries: [file] });
    apiClient.projectCapabilities = async () => writable;
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByText("brief.txt");
      fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), { target: { value: "missing" } });
      await screen.findByRole("heading", { name: "No matching files" });
      assert.equal(screen.queryByRole("heading", { name: "No files yet" }), null);
      fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
      assert.ok(screen.getByText("brief.txt"));
    } finally { restoreClient(original); }
  });

  it("shows and announces the single-file drop target state", async () => {
    const original = snapshotClient();
    apiClient.files = async () => ({ entries: [file] });
    apiClient.projectCapabilities = async () => writable;
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByText("brief.txt");
      const target = document.querySelector<HTMLElement>("[aria-label='Project files']");
      assert.ok(target);
      fireEvent.dragEnter(target, { dataTransfer: { files: [new File(["hello"], "drop.txt")] } });
      assert.match(target.className, /ring-2/);
      assert.equal(screen.getByText("Drop a file to upload").getAttribute("aria-live"), "polite");
      fireEvent.drop(target, { dataTransfer: { files: [] } });
      assert.doesNotMatch(target.className, /ring-2/);
    } finally { restoreClient(original); }
  });
});

function DeleteDialogHarness() {
  const [open, setOpen] = React.useState(true);
  return <DeleteFileDialog entry={open ? file : undefined} deleting={false} onCancel={() => setOpen(false)} onConfirm={() => undefined} />;
}

function snapshotClient() { return { files: apiClient.files, projectCapabilities: apiClient.projectCapabilities, uploadFile: apiClient.uploadFile, deleteFile: apiClient.deleteFile }; }
function restoreClient(original: ReturnType<typeof snapshotClient>) { apiClient.files = original.files; apiClient.projectCapabilities = original.projectCapabilities; apiClient.uploadFile = original.uploadFile; apiClient.deleteFile = original.deleteFile; }
function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
