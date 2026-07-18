import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type ProjectCapabilities, type ProjectFile } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { DeleteFileDialog, ProjectFilesPage, invalidateFilePreview } = await import("../../src/components/files/ProjectFilesPage.js");

const file: ProjectFile = { name: "brief.txt", path: "files/brief.txt", type: "file", size: 12, updatedAt: "2026-07-11T00:00:00.000Z" };
const writable: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true };
const readOnly: ProjectCapabilities = { ...writable, canWriteFiles: false };

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("project files browser", () => {
  it("opens a nested directory from the URL without first loading the root", async () => {
    const original = snapshotClient();
    const paths: string[] = [];
    apiClient.files = async (_projectId, path) => { paths.push(path); return { entries: [] }; };
    apiClient.projectCapabilities = async () => readOnly;
    window.history.replaceState(null, "", "/files?path=files%2Freports");
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "This folder is empty" });
      assert.deepEqual(paths, ["files/reports"]);
      assert.ok(screen.getByRole("button", { name: "reports" }));
    } finally { restoreClient(original); }
  });

  it("keeps directory navigation in the URL and restores it on browser navigation", async () => {
    const original = snapshotClient();
    const folder: ProjectFile = { name: "reports", path: "files/reports", type: "directory", updatedAt: file.updatedAt };
    const paths: string[] = [];
    apiClient.files = async (_projectId, path) => { paths.push(path); return { entries: path === "files" ? [folder] : [] }; };
    apiClient.projectCapabilities = async () => readOnly;
    window.history.replaceState(null, "", "/files");
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "reports" }));
      await screen.findByRole("heading", { name: "This folder is empty" });
      assert.equal(window.location.search, "?path=files%2Freports");

      window.history.replaceState(null, "", "/files");
      await act(async () => window.dispatchEvent(new window.PopStateEvent("popstate")));
      await screen.findByRole("button", { name: "reports" });
      assert.equal(paths.at(-1), "files");
    } finally { restoreClient(original); }
  });

  it("normalizes an unsafe file URL to the project files root", async () => {
    const original = snapshotClient();
    const paths: string[] = [];
    apiClient.files = async (_projectId, path) => { paths.push(path); return { entries: [] }; };
    apiClient.projectCapabilities = async () => readOnly;
    window.history.replaceState(null, "", "/files?path=..%2Fsecrets");
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "No files yet" });
      assert.deepEqual(paths, ["files"]);
      assert.equal(window.location.search, "");
    } finally { restoreClient(original); }
  });

  it("exposes one named upload action instead of a second focusable file input", async () => {
    const original = snapshotClient();
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => ({ entries: [] });
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("button", { name: "Upload" });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      assert.equal(input.hidden, true);
    } finally { restoreClient(original); }
  });

  it("commits a successful upload without depending on another listing read", async () => {
    const original = snapshotClient();
    let lists = 0;
    const uploaded: string[] = [];
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => { lists++; return { entries: [] }; };
    apiClient.uploadFile = async (_projectId, path) => {
      uploaded.push(path);
      return { path, bytes: 1, mediaType: "text/plain", updatedAt: file.updatedAt };
    };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "No files yet" });
      const input = document.querySelector('input[type="file"]')!;
      fireEvent.change(input, { target: { files: [new File(["a"], "brief.txt")] } });
      await waitFor(() => assert.deepEqual(uploaded, ["files/brief.txt"]));
      assert.ok(screen.getByText("brief.txt"));
      assert.equal(lists, 1);
    } finally { restoreClient(original); }
  });

  it("locks file deletion while an upload is pending", async () => {
    const original = snapshotClient();
    let uploadStarted = false;
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => ({ entries: [file] });
    apiClient.uploadFile = async () => {
      uploadStarted = true;
      return new Promise(() => undefined);
    };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name:"brief.txt" }));
      fireEvent.change(document.querySelector('input[type="file"]')!, { target:{ files:[new File(["a"], "new.txt")] } });
      await waitFor(() => assert.equal(uploadStarted, true));
      for (const button of screen.getAllByRole("button", { name:"Delete" })) assert.equal(button.hasAttribute("disabled"), true);
    } finally { restoreClient(original); }
  });

  it("does not insert an upload response into a different folder", async () => {
    const original = snapshotClient();
    const folder: ProjectFile = { name: "reports", path: "files/reports", type: "directory", updatedAt: file.updatedAt };
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async (_projectId, path) => ({ entries: path === "files" ? [folder] : [] });
    apiClient.uploadFile = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { path: file.path, bytes: 1, mediaType: "text/plain", updatedAt: file.updatedAt };
    };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByText("reports");
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "brief.txt")] } });
      fireEvent.click(screen.getByRole("button", { name: "reports" }));
      await screen.findByRole("heading", { name: "This folder is empty" });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      assert.equal(screen.queryByText("brief.txt"), null);
      assert.ok(screen.getByRole("heading", { name: "This folder is empty" }));
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

  it("fails closed when the project is archived during a file upload", async () => {
    const original = snapshotClient();
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => ({ entries: [file] });
    apiClient.uploadFile = async () => { throw new ApiError(409, "Project is archived"); };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByText("brief.txt");
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "denied.txt")] } });
      await screen.findByText("File write access changed. Files are now read-only.");
      assert.equal(screen.queryByRole("button", { name: "Upload" }), null);
      assert.equal(screen.queryByRole("button", { name: "Retry upload" }), null);
      fireEvent.click(screen.getByRole("button", { name: "brief.txt" }));
      assert.equal(screen.queryByRole("button", { name: "Delete" }), null);
      assert.ok(screen.getAllByRole("link", { name: "Download" }).length > 0);
    } finally { restoreClient(original); }
  });

  it("keeps files readable when an upload discovers write access was removed", async () => {
    const original = snapshotClient();
    let capabilityReads = 0;
    apiClient.projectCapabilities = async () => ++capabilityReads === 1 ? writable : readOnly;
    apiClient.files = async () => ({ entries: [file] });
    apiClient.uploadFile = async () => { throw new ApiError(403, "File upload is not allowed"); };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByText("brief.txt");
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "denied.txt")] } });

      await screen.findByText("File write access changed. Files are now read-only.");
      assert.ok(screen.getByRole("button", { name: "brief.txt" }));
      assert.equal(screen.queryByRole("button", { name: "Upload" }), null);
      assert.equal(capabilityReads, 2);
    } finally { restoreClient(original); }
  });

  it("clears files when an upload discovers project access was removed", async () => {
    const original = snapshotClient();
    let removed = false;
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => {
      if (removed) throw new ApiError(403, "Project not found");
      return { entries: [file] };
    };
    apiClient.uploadFile = async () => { removed = true; throw new ApiError(403, "Project not found"); };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByText("brief.txt");
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "denied.txt")] } });

      await screen.findByRole("heading", { name: "Files unavailable" });
      assert.equal(screen.queryByRole("button", { name: "brief.txt" }), null);
      assert.equal(screen.queryByRole("button", { name: "Upload" }), null);
    } finally { restoreClient(original); }
  });

  it("retries the same failed file", async () => {
    const original = snapshotClient();
    let attempts = 0;
    const uploaded: string[] = [];
    const keys: Array<string | undefined> = [];
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => ({ entries: [] });
    apiClient.uploadFile = async (_projectId, path, _file, options) => {
      attempts++;
      uploaded.push(path);
      keys.push(options?.idempotencyKey);
      if (attempts === 1) throw new Error("network unavailable");
      return { path, bytes: 1, mediaType: "text/plain", updatedAt: file.updatedAt };
    };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "No files yet" });
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["a"], "brief.txt")] } });
      await screen.findByRole("button", { name: "Retry upload" });
      fireEvent.click(screen.getByRole("button", { name: "Retry upload" }));
      await waitFor(() => assert.deepEqual(uploaded, ["files/brief.txt", "files/brief.txt"]));
      assert.ok(keys[0]);
      assert.equal(keys[1], keys[0]);
      await waitFor(() => assert.equal(screen.queryByRole("button", { name: "Retry upload" }), null));
    } finally { restoreClient(original); }
  });

  it("requires explicit confirmation before replacing an existing file", async () => {
    const original = snapshotClient();
    const attempts: boolean[] = [];
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => ({ entries: [file] });
    apiClient.uploadFile = async (_projectId, _path, _file, options) => {
      attempts.push(options?.overwrite === true);
      if (!options?.overwrite) throw new ApiError(409, "Project file already exists");
      return { path: file.path, bytes: file.size ?? 0, mediaType: "text/plain", updatedAt: file.updatedAt };
    };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByText("brief.txt");
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["replacement"], "brief.txt")] } });
      const dialog = await screen.findByRole("alertdialog", { name: "Replace brief.txt?" });
      assert.match(dialog.textContent ?? "", /permanently replace/i);
      fireEvent.click(screen.getByRole("button", { name: "Replace file" }));
      await waitFor(() => assert.deepEqual(attempts, [false, true]));
      await waitFor(() => assert.equal(screen.queryByRole("alertdialog", { name: "Replace brief.txt?" }), null));
    } finally { restoreClient(original); }
  });

  it("shows quota conflicts as upload errors instead of replacement prompts", async () => {
    const original = snapshotClient();
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => ({ entries: [] });
    apiClient.uploadFile = async () => {
      throw new ApiError(409, "Project file bytes limit reached", "project_file_bytes_limit_reached");
    };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "No files yet" });
      fireEvent.change(document.querySelector('input[type="file"]')!, {
        target: { files: [new File(["a"], "quota-denied.txt")] },
      });
      const alert = await screen.findByRole("alert");
      assert.match(alert.textContent ?? "", /file storage limit reached/i);
      assert.equal(screen.getByRole("link", { name: "Open resource policy" }).getAttribute("href"), "policy");
      assert.equal(screen.queryByRole("button", { name: "Retry upload" }), null);
      assert.equal(screen.queryByRole("alertdialog", { name: "Replace quota-denied.txt?" }), null);
    } finally { restoreClient(original); }
  });

  it("commits a successful delete without depending on another listing read", async () => {
    const original = snapshotClient();
    let lists = 0;
    let deletes = 0;
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => { lists++; return { entries: [file] }; };
    apiClient.deleteFile = async () => { deletes++; return { deleted: true }; };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "brief.txt" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
      const dialog = await screen.findByRole("alertdialog", { name: "Delete file?" });
      const confirm = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Delete");
      assert.ok(confirm);
      await act(async () => { fireEvent.click(confirm); await Promise.resolve(); });
      assert.equal(deletes, 1);
      assert.equal(lists, 1);
      assert.equal(screen.queryByText("brief.txt"), null);
    } finally { restoreClient(original); }
  });

  it("removes a file that disappeared before deletion completed", async () => {
    const original = snapshotClient();
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => ({ entries: [file] });
    apiClient.deleteFile = async () => { throw new ApiError(404, "File not found"); };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "brief.txt" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
      const dialog = await screen.findByRole("alertdialog", { name: "Delete file?" });
      const confirm = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Delete");
      assert.ok(confirm);
      await act(async () => { fireEvent.click(confirm); await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.equal(screen.queryByRole("alertdialog", { name: "Delete file?" }), null);
      assert.equal(screen.queryByText("brief.txt"), null);
    } finally { restoreClient(original); }
  });

  it("reuses a file deletion key after an unknown network result", async () => {
    const original = snapshotClient();
    const keys: string[] = [];
    let attempts = 0;
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async () => ({ entries: [file] });
    apiClient.deleteFile = (async (_projectId:string,_path:string,key:string)=>{keys.push(key);if(++attempts===1)throw new Error("connection closed");return{deleted:true as const};}) as typeof apiClient.deleteFile;
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "brief.txt" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
      const dialog = await screen.findByRole("alertdialog", { name: "Delete file?" });
      const confirm = () => Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Delete")!;
      fireEvent.click(confirm());
      await screen.findByText(/connection closed/);
      fireEvent.click(confirm());
      await waitFor(() => assert.equal(attempts, 2));
      assert.ok(keys[0]);assert.equal(keys[1],keys[0]);
      await waitFor(() => assert.equal(screen.queryByText("brief.txt"), null));
    } finally { restoreClient(original); }
  });

  it("does not apply a completed delete after switching projects", async () => {
    const original = snapshotClient();
    const secondFile: ProjectFile = { ...file, name: "second.txt", path: "files/second.txt" };
    let finishDelete: (() => void) | undefined;
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async (requestedProjectId) => ({ entries: requestedProjectId === "project_1" ? [file] : [secondFile] });
    apiClient.deleteFile = async () => new Promise((resolve) => { finishDelete = () => resolve({ deleted: true }); });
    try {
      const view = render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "brief.txt" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
      const dialog = await screen.findByRole("alertdialog", { name: "Delete file?" });
      const confirm = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Delete");
      assert.ok(confirm);
      fireEvent.click(confirm);
      await waitFor(() => assert.ok(finishDelete));

      view.rerender(<ProjectFilesPage projectId="project_2" />);
      await screen.findByText("second.txt");
      await act(async () => finishDelete!());
      assert.ok(screen.getByText("second.txt"));
      assert.equal(screen.queryByText("brief.txt"), null);
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

  it("ignores a stale folder response after the user returns to the root", async () => {
    const original = snapshotClient();
    const folder: ProjectFile = { name: "reports", path: "files/reports", type: "directory", updatedAt: file.updatedAt };
    const stale: ProjectFile = { ...file, name: "stale.txt", path: "files/reports/stale.txt" };
    let rootReads = 0;
    let folderStarted = false;
    let resolveFolder!: (value: { entries: ProjectFile[] }) => void;
    const folderResponse = new Promise<{ entries: ProjectFile[] }>((resolve) => { resolveFolder = resolve; });
    apiClient.projectCapabilities = async () => writable;
    apiClient.files = async (_projectId, path) => {
      if (path === folder.path) {
        folderStarted = true;
        return folderResponse;
      }
      rootReads += 1;
      return { entries: rootReads === 1 ? [folder] : [file] };
    };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "reports" }));
      await waitFor(() => assert.equal(folderStarted, true));
      fireEvent.click(screen.getByRole("button", { name: "files" }));
      await screen.findByText("brief.txt");
      await act(async () => { resolveFolder({ entries: [stale] }); });
      assert.ok(screen.getByText("brief.txt"));
      assert.equal(screen.queryByText("stale.txt"), null);
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

  it("keeps files readable but fails closed to read-only when capabilities are unavailable", async () => {
    const original = snapshotClient();
    apiClient.files = async () => ({ entries: [file] });
    apiClient.projectCapabilities = async () => { throw new ApiError(503, "Permissions unavailable"); };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByText("brief.txt");
      assert.match(screen.getByRole("alert").textContent ?? "", /read-only until refreshed/i);
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

  it("removes a file that disappeared before preview", async () => {
    const original = snapshotClient();
    apiClient.files = async () => ({ entries: [{ ...file, mediaType:"text/plain" }] });
    apiClient.projectCapabilities = async () => writable;
    apiClient.downloadProjectFile = async () => { throw new ApiError(404, "File not found"); };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name:"brief.txt" }));
      fireEvent.click(screen.getAllByRole("button", { name:"Preview" })[0]!);
      await waitFor(() => assert.equal(screen.queryByText("brief.txt"), null));
      assert.ok(screen.getByRole("heading", { name:"No files yet" }));
    } finally { restoreClient(original); }
  });

  it("invalidates only the preview bound to a replaced or deleted path", () => {
    const preview = { kind: "text" as const, value: "old", name: file.name, path: file.path };
    assert.equal(invalidateFilePreview(preview, file.path), null);
    assert.equal(invalidateFilePreview(preview, "files/other.txt"), preview);
  });

  it("closes the selected file preview when navigating into a folder", async () => {
    const original = snapshotClient();
    const folder: ProjectFile = { name: "reports", path: "files/reports", type: "directory", updatedAt: file.updatedAt };
    apiClient.files = async (_projectId, path) => ({ entries: path === "files" ? [file, folder] : [] });
    apiClient.projectCapabilities = async () => writable;
    apiClient.downloadProjectFile = async () => new Blob(["preview"], { type: "text/plain" });
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "brief.txt" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Preview" })[0]!);
      await screen.findByText("preview");
      fireEvent.click(screen.getByRole("button", { name: "reports" }));
      await screen.findByRole("heading", { name: "This folder is empty" });
      assert.equal(screen.queryByText("preview"), null);
    } finally { restoreClient(original); }
  });

  it("ignores a preview download that finishes after folder navigation", async () => {
    const original = snapshotClient();
    const folder: ProjectFile = { name: "reports", path: "files/reports", type: "directory", updatedAt: file.updatedAt };
    apiClient.files = async (_projectId, path) => ({ entries: path === "files" ? [file, folder] : [] });
    apiClient.projectCapabilities = async () => writable;
    apiClient.downloadProjectFile = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Blob(["stale preview"], { type: "text/plain" });
    };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "brief.txt" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Preview" })[0]!);
      fireEvent.click(screen.getByRole("button", { name: "reports" }));
      await screen.findByRole("heading", { name: "This folder is empty" });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      assert.equal(screen.queryByText("stale preview"), null);
      assert.ok(screen.getByRole("heading", { name: "This folder is empty" }));
    } finally { restoreClient(original); }
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

function snapshotClient() { return { files: apiClient.files, projectCapabilities: apiClient.projectCapabilities, uploadFile: apiClient.uploadFile, downloadProjectFile: apiClient.downloadProjectFile, deleteFile: apiClient.deleteFile }; }
function restoreClient(original: ReturnType<typeof snapshotClient>) { apiClient.files = original.files; apiClient.projectCapabilities = original.projectCapabilities; apiClient.uploadFile = original.uploadFile; apiClient.downloadProjectFile = original.downloadProjectFile; apiClient.deleteFile = original.deleteFile; }
function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
}
