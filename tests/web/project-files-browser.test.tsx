import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type FileLibrary, type ProjectCapabilities, type ProjectFile } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { ProjectFilesPage } = await import("../../src/components/files/ProjectFilesPage.js");

const capabilities: ProjectCapabilities = { canManageEndpoints: false, canManageMembers: false, canManagePolicy: false, canWriteFiles: true, canCreateTasks: true, canCancelTasks: true, canSendChat: true };
const first = library("library_1", "Research");
const second = library("library_2", "Design assets");
const file: ProjectFile = { name: "brief.txt", path: "brief.txt", type: "file", size: 12, mediaType: "text/plain", updatedAt: "2026-07-19T00:00:00.000Z" };

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/files");
});

describe("File Libraries page", () => {
  it("lists accessible libraries, selects the URL library, and browses its directory", async () => {
    const original = snapshotClient();
    const reads: Array<[string, string]> = [];
    apiClient.fileLibraries = async () => [first, second];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.libraryFiles = async (_projectId, libraryId, path) => { reads.push([libraryId, path]); return { entries: [file] }; };
    window.history.replaceState(null, "", "/files?libraryId=library_2&path=reports");
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("button", { name: "brief.txt" });
      assert.equal(screen.getByRole("button", { name: "Select library Design assets" }).getAttribute("aria-current"), "true");
      assert.equal(screen.getByRole("button", { name: "Select library Research" }).getAttribute("aria-current"), null);
      assert.deepEqual(reads, [["library_2", "reports"]]);
      assert.ok(screen.getByRole("navigation", { name: "Library path" }));
    } finally { restoreClient(original); }
  });

  it("switches libraries, resets the directory, and clears a stale file selection", async () => {
    const original = snapshotClient();
    const reads: Array<[string, string]> = [];
    apiClient.fileLibraries = async () => [first, second];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.libraryFiles = async (_projectId, libraryId, path) => { reads.push([libraryId, path]); return { entries: libraryId === first.id ? [file] : [] }; };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "brief.txt" }));
      assert.equal(screen.getAllByRole("heading", { name: "brief.txt" }).length, 2);
      fireEvent.click(screen.getByRole("button", { name: "Select library Design assets" }));
      await screen.findByRole("heading", { name: "No files yet" });
      assert.equal(window.location.search, "?libraryId=library_2");
      assert.deepEqual(reads.at(-1), ["library_2", ""]);
      assert.ok(screen.getByText("Select a file to view its details."));
    } finally { restoreClient(original); }
  });

  it("shows the empty-library state and allows creation only from the server capability", async () => {
    const original = snapshotClient();
    apiClient.fileLibraries = async () => [];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.createFileLibrary = async (_projectId, name) => library("library_3", name);
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "No File Libraries" });
      fireEvent.click(screen.getAllByRole("button", { name: "Create library" })[0]!);
      fireEvent.change(screen.getByLabelText("Library name"), { target: { value: "Task notes" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      await screen.findByRole("button", { name: "Select library Task notes" });
      assert.equal(window.location.search, "?libraryId=library_3");
    } finally { restoreClient(original); }
  });

  it("keeps a duplicate-name conflict in the create dialog", async () => {
    const original = snapshotClient();
    apiClient.fileLibraries = async () => [first];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.libraryFiles = async () => ({ entries: [] });
    apiClient.createFileLibrary = async () => { throw new ApiError(409, "File Library name already exists"); };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click((await screen.findAllByRole("button", { name: "Create library" }))[0]!);
      fireEvent.change(screen.getByLabelText("Library name"), { target: { value: "Research" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      const alert = await screen.findByRole("alert");
      assert.match(alert.textContent ?? "", /name already exists/i);
      assert.ok(screen.getByRole("dialog", { name: "Create File Library" }));
    } finally { restoreClient(original); }
  });

  it("uploads, safely previews, downloads, and deletes within the selected library", async () => {
    const original = snapshotClient();
    const calls: Array<[string, string]> = [];
    apiClient.fileLibraries = async () => [first];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.libraryFiles = async () => ({ entries: [file] });
    apiClient.uploadLibraryFile = async (_projectId, libraryId, path) => { calls.push([`upload:${libraryId}`, path]); return { path, bytes: 3, mediaType: "text/plain", updatedAt: file.updatedAt }; };
    apiClient.previewLibraryFile = async (_projectId, libraryId, path) => { calls.push([`preview:${libraryId}`, path]); return { size: 7, type: "text/plain", text: async () => "preview" } as Blob; };
    apiClient.deleteLibraryFile = async (_projectId, libraryId, path) => { calls.push([`delete:${libraryId}`, path]); return { deleted: true }; };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "brief.txt" }));
      assert.equal(screen.getAllByRole("link", { name: "Download" })[0]!.getAttribute("href"), "/api/v1/projects/project_1/file-libraries/library_1/files/download?path=brief.txt");

      fireEvent.click(screen.getAllByRole("button", { name: "Preview" })[0]!);
      await screen.findByText("preview");

      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["new"], "notes.txt", { type: "text/plain" })] } });
      await waitFor(() => assert.ok(calls.some(([operation, path]) => operation === "upload:library_1" && path === "notes.txt")));

      fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
      const dialog = await screen.findByRole("alertdialog", { name: "Delete file?" });
      fireEvent.click(Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Delete")!);
      await waitFor(() => assert.ok(calls.some(([operation, path]) => operation === "delete:library_1" && path === "brief.txt")));
      assert.ok(calls.some(([operation, path]) => operation === "preview:library_1" && path === "brief.txt"));
    } finally { restoreClient(original); }
  });

  it("does not offer a stale upload retry or replacement after switching libraries", async () => {
    const original = snapshotClient();
    let rejectUpload: ((error: unknown) => void) | undefined;
    apiClient.fileLibraries = async () => [first, second];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.libraryFiles = async () => ({ entries: [] });
    apiClient.uploadLibraryFile = async () => new Promise((_, reject) => { rejectUpload = reject; });
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "No files yet" });
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["new"], "notes.txt", { type: "text/plain" })] } });
      await waitFor(() => assert.ok(rejectUpload));
      fireEvent.click(screen.getByRole("button", { name: "Select library Design assets" }));
      rejectUpload!(new ApiError(409, "Project file already exists"));
      await act(async () => { await Promise.resolve(); });
      assert.equal(screen.queryByRole("alertdialog", { name: "Replace notes.txt?" }), null);
      assert.equal(screen.queryByRole("button", { name: "Retry upload" }), null);
      assert.equal(window.location.search, "?libraryId=library_2");
    } finally { restoreClient(original); }
  });

  it("retries an upload against its originating library", async () => {
    const original = snapshotClient();
    const uploadLibraries: string[] = [];
    apiClient.fileLibraries = async () => [first, second];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.libraryFiles = async () => ({ entries: [] });
    apiClient.uploadLibraryFile = async (_projectId, libraryId, path) => {
      uploadLibraries.push(libraryId);
      if (uploadLibraries.length === 1) throw new Error("network unavailable");
      return { path, bytes: 3, mediaType: "text/plain", updatedAt: file.updatedAt };
    };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "No files yet" });
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["new"], "notes.txt", { type: "text/plain" })] } });
      fireEvent.click(await screen.findByRole("button", { name: "Retry upload" }));
      await waitFor(() => assert.deepEqual(uploadLibraries, [first.id, first.id]));
    } finally { restoreClient(original); }
  });

  it("ignores a stale file-list error immediately after a location change", async () => {
    const original = snapshotClient();
    let rejectFirst: ((error: unknown) => void) | undefined;
    apiClient.fileLibraries = async () => [first, second];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.libraryFiles = async (_projectId, libraryId) => libraryId === first.id
      ? new Promise((_, reject) => { rejectFirst = reject; })
      : { entries: [] };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      await waitFor(() => assert.ok(rejectFirst));
      window.history.replaceState(null, "", "/files?libraryId=library_2");
      window.dispatchEvent(new Event("popstate"));
      rejectFirst!(new Error("stale Research failure"));
      await screen.findByRole("heading", { name: "No files yet" });
      assert.equal(screen.queryByText("stale Research failure"), null);
      assert.equal(screen.getByRole("button", { name: "Select library Design assets" }).getAttribute("aria-current"), "true");
    } finally { restoreClient(original); }
  });

  it("renames a library using its projected capability and concurrency token", async () => {
    const original = snapshotClient();
    const inputs: Array<{ name: string; expectedUpdatedAt: string }> = [];
    apiClient.fileLibraries = async () => [first];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.libraryFiles = async () => ({ entries: [] });
    apiClient.renameFileLibrary = async (_projectId, _libraryId, input) => { inputs.push(input); return { ...first, name: input.name, updatedAt: "later" }; };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Rename Research" }));
      fireEvent.change(screen.getByLabelText("Library name"), { target: { value: "References" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByRole("button", { name: "Select library References" });
      assert.deepEqual(inputs, [{ name: "References", expectedUpdatedAt: first.updatedAt }]);
    } finally { restoreClient(original); }
  });

  it("links an authorized bound Task without nesting it in the library selector", async () => {
    const original = snapshotClient();
    const bound = { ...first, boundTask: { id: "task_1", title: "Quarterly report" }, capabilities: { ...first.capabilities, canDelete: false } };
    apiClient.fileLibraries = async () => [bound];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.libraryFiles = async () => ({ entries: [] });
    try {
      render(<ProjectFilesPage workspaceId="workspace_1" projectId="project_1" />);
      const link = await screen.findByRole("link", { name: "Bound to Quarterly report" });
      assert.equal(link.getAttribute("href"), "/workspaces/workspace_1/projects/project_1/tasks/task_1");
      assert.equal(screen.getByRole("button", { name: "Select library Research" }).querySelector("a"), null);
      const button = screen.getByRole("button", { name: "Delete Research" });
      assert.equal(button.hasAttribute("disabled"), true);
      assert.match(button.getAttribute("title") ?? "", /bound to a Task/i);
    } finally { restoreClient(original); }
  });

  it("surfaces a nonempty-library 409 in the delete confirmation", async () => {
    const original = snapshotClient();
    apiClient.fileLibraries = async () => [first];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.libraryFiles = async () => ({ entries: [file] });
    apiClient.deleteFileLibrary = async () => { throw new ApiError(409, "File Library is not empty"); };
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Delete Research" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete library" }));
      const alert = await screen.findByRole("alert");
      assert.match(alert.textContent ?? "", /not empty/i);
      assert.ok(screen.getByRole("alertdialog", { name: "Delete File Library?" }));
    } finally { restoreClient(original); }
  });

  it("selects the next library and clears the URL path after deletion", async () => {
    const original = snapshotClient();
    apiClient.fileLibraries = async () => [first, second];
    apiClient.projectCapabilities = async () => capabilities;
    apiClient.libraryFiles = async () => ({ entries: [] });
    apiClient.deleteFileLibrary = async () => ({ deleted: true });
    window.history.replaceState(null, "", "/files?libraryId=library_1&path=reports");
    try {
      render(<ProjectFilesPage projectId="project_1" />);
      fireEvent.click(await screen.findByRole("button", { name: "Delete Research" }));
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete library" })); await Promise.resolve(); });
      await waitFor(() => assert.equal(screen.queryByRole("button", { name: /Research/ }), null));
      assert.equal(screen.getByRole("button", { name: "Select library Design assets" }).getAttribute("aria-current"), "true");
      assert.equal(window.location.search, "?libraryId=library_2");
    } finally { restoreClient(original); }
  });
});

function library(id: string, name: string): FileLibrary {
  return { id, workspaceId: "workspace_1", projectId: "project_1", name, rootSubPath: `file-libraries/${id}`, createdByUserId: "user_1", createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z", boundTask: null, capabilities: { canRename: true, canDelete: true, canWriteFiles: true } };
}

function snapshotClient() {
  return {
    fileLibraries: apiClient.fileLibraries,
    projectCapabilities: apiClient.projectCapabilities,
    libraryFiles: apiClient.libraryFiles,
    createFileLibrary: apiClient.createFileLibrary,
    renameFileLibrary: apiClient.renameFileLibrary,
    deleteFileLibrary: apiClient.deleteFileLibrary,
    uploadLibraryFile: apiClient.uploadLibraryFile,
    previewLibraryFile: apiClient.previewLibraryFile,
    deleteLibraryFile: apiClient.deleteLibraryFile
  };
}

function restoreClient(original: ReturnType<typeof snapshotClient>) { Object.assign(apiClient, original); }

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/files" });
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLFormElement: dom.window.HTMLFormElement, Element: dom.window.Element, Document: dom.window.Document, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, File: dom.window.File, Blob: dom.window.Blob, URL: dom.window.URL, getComputedStyle: dom.window.getComputedStyle, MutationObserver: dom.window.MutationObserver, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0), cancelAnimationFrame: (id: number) => clearTimeout(id), IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent });
  Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {} });
}
