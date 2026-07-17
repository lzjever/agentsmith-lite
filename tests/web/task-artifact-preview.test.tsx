import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient, type TaskArtifact } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { TaskArtifactsPanel } = await import("../../src/components/tasks/TaskArtifactsPanel.js");

afterEach(() => cleanup());

const image: TaskArtifact = { id: "artifact_image", taskId: "task_1", fileId: "file_image", name: "diagram.png", bytes: 3, mediaType: "image/png", previewText: "<not rendered>", createdAt: "2026-07-12T00:00:00.000Z" };

describe("task artifact previews", () => {
  it("loads authorized image blobs into a closable viewer and revokes the object URL", async () => {
    const original = apiClient.downloadTaskArtifact;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    apiClient.downloadTaskArtifact = async () => new Blob([Uint8Array.of(1, 2, 3)], { type: "image/png" });
    URL.createObjectURL = () => "blob:artifact-image";
    URL.revokeObjectURL = (value) => { revoked.push(value); };
    try {
      render(<TaskArtifactsPanel taskId="task_1" artifacts={[image, { ...image, id: "html", name: "unsafe.html", mediaType: "text/html", previewText: "<img src=x>" }, { ...image, id: "binary", name: "payload.bin", mediaType: "application/octet-stream", previewText: "not shown" }]} />);
      assert.equal(screen.queryByRole("button", { name: "View unsafe.html" }), null);
      assert.equal(screen.queryByText("<img src=x>"), null);
      fireEvent.click(screen.getByRole("button", { name: "View diagram.png" }));
      await screen.findByRole("img", { name: "diagram.png" });
      fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
      await waitFor(() => assert.deepEqual(revoked, ["blob:artifact-image"]));
    } finally {
      apiClient.downloadTaskArtifact = original;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it("keeps an authorized download failure in the viewer with a retry", async () => {
    const original = apiClient.downloadTaskArtifact;
    let calls = 0;
    apiClient.downloadTaskArtifact = async () => { calls += 1; if (calls === 1) throw new ApiError(403, "Artifact access denied"); return new Blob([Uint8Array.of(1)], { type: "image/png" }); };
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = () => "blob:retried";
    try {
      render(<TaskArtifactsPanel taskId="task_1" artifacts={[image]} />);
      fireEvent.click(screen.getByRole("button", { name: "View diagram.png" }));
      await screen.findByRole("alert");
      assert.match(screen.getByRole("alert").textContent ?? "", /Artifact access denied/);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await screen.findByRole("img", { name: "diagram.png" });
      assert.equal(calls, 2);
    } finally { apiClient.downloadTaskArtifact = original; URL.createObjectURL = originalCreate; }
  });

  it("filters artifacts by type, shows a count, and supports a manual refresh", async () => {
    let refreshes = 0;
    render(<TaskArtifactsPanel taskId="task_1" artifacts={[image, { ...image, id: "notes", name: "notes.txt", mediaType: "text/plain", previewText: "safe" }, { ...image, id: "binary", name: "payload.bin", mediaType: "application/octet-stream" }]} onRefresh={() => { refreshes += 1; }} />);
    assert.ok(screen.getByText("3 artifacts"));
    fireEvent.click(screen.getByRole("combobox", { name: "Artifact type" }));
    fireEvent.click(await screen.findByRole("option", { name: "Images" }));
    assert.ok(screen.getByText("diagram.png"));
    assert.equal(screen.queryByText("notes.txt"), null);
    fireEvent.click(screen.getByRole("button", { name: "Refresh artifacts" }));
    assert.equal(refreshes, 1);
  });

  it("treats JSON artifacts as safe text previews", async () => {
    const json = { ...image, id: "json", name: "result.json", mediaType: "application/json", previewText: '{"ok":true}' };
    render(<TaskArtifactsPanel taskId="task_1" artifacts={[json]} />);

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    assert.ok(screen.getByText('{"ok":true}'));
    fireEvent.click(screen.getByRole("combobox", { name: "Artifact type" }));
    fireEvent.click(await screen.findByRole("option", { name: "Text" }));
    assert.ok(screen.getByText("result.json"));
  });

  it("keeps oversized artifacts downloadable without loading them into a preview", () => {
    render(<TaskArtifactsPanel taskId="task_1" artifacts={[
      { ...image, id:"large-image", name:"large.png", bytes:8 * 1024 * 1024 + 1 },
      { ...image, id:"large-text", name:"large.txt", mediaType:"text/plain", bytes:512 * 1024 + 1, previewText:null }
    ]} />);

    assert.equal(Boolean(screen.queryByRole("button", { name:"View large.png" })), false);
    assert.equal(Boolean(screen.queryByRole("button", { name:"Preview" })), false);
    assert.ok(screen.getByRole("link", { name:"Download large.png" }));
    assert.ok(screen.getByRole("link", { name:"Download large.txt" }));
  });

  it("rejects an image preview response larger than its declared safe size", async () => {
    const original = apiClient.downloadTaskArtifact;
    apiClient.downloadTaskArtifact = async () => ({ size:8 * 1024 * 1024 + 1, type:"image/png" }) as Blob;
    try {
      render(<TaskArtifactsPanel taskId="task_1" artifacts={[image]} />);
      fireEvent.click(screen.getByRole("button", { name:"View diagram.png" }));
      assert.ok(await screen.findByText("Image preview is too large."));
      assert.equal(Boolean(screen.queryByRole("img", { name:"diagram.png" })), false);
    } finally { apiClient.downloadTaskArtifact = original; }
  });
});

function installDom() { const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" }); Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, HTMLInputElement: dom.window.HTMLInputElement, HTMLFormElement: dom.window.HTMLFormElement, DocumentFragment: dom.window.DocumentFragment, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true }); Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator }); Object.assign(dom.window, { PointerEvent: dom.window.MouseEvent }); if (!("scrollIntoView" in dom.window.HTMLElement.prototype)) Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView() {} }); if (!("ResizeObserver" in globalThis)) Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } }); }
