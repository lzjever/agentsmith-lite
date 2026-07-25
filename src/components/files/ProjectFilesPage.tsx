"use client";

import { ArrowLeft, ChevronLeft, ChevronRight, Download, FileText, Folder, FolderOpen, FolderUp, Image, Pencil, Plus, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { Banner, Button, Collapsible, EmptyState, FileInput, Heading, IconButton, Selector, Skeleton, Text, TextInput, useToast } from "@astryxdesign/core";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type FileLibrary, type ProjectFile } from "../../lib/api/client";
import { formatLocalDateTime } from "../../lib/format/date";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import {
  createInlinePreviewRequest,
  isInlinePreviewAvailable,
  type InlinePreviewByteLimits,
  type InlinePreviewContent,
  type InlinePreviewRequest
} from "../media/inline-preview";
import { ConfirmationDialog, Dialog } from "../ui/Dialog";
import { filesReturnToAfterNavigation } from "../tasks/task-peer-navigation";
import {
  createFileBrowserState,
  reduceFileBrowserState,
  selectFileBrowserPage,
  type FileBrowserSort
} from "./fileBrowserState";

type LoadState = "loading" | "ready" | "error";
const filePreviewByteLimits = { text: 512_000, image: 512_000 } satisfies InlinePreviewByteLimits;
const fileSortOptions = [
  { value: "name:asc", label: "Name A-Z" },
  { value: "name:desc", label: "Name Z-A" },
  { value: "size:asc", label: "Smallest first" },
  { value: "size:desc", label: "Largest first" },
  { value: "updatedAt:desc", label: "Recently updated" },
  { value: "updatedAt:asc", label: "Oldest updated" }
];
export type FilePreview = InlinePreviewContent & { name: string; path: string };
type FilePreviewState =
  | { status: "idle" }
  | { status: "loading"; path: string }
  | { status: "error"; path: string; message: string }
  | { status: "ready"; preview: FilePreview };
type DeleteFileTarget = { libraryId: string; entry: ProjectFile };

export function ProjectFilesPage({ workspaceId, projectId }: { workspaceId?: string; projectId: string }) {
  return <ProjectFiles key={`${workspaceId ?? "workspace"}:${projectId}`} workspaceId={workspaceId} projectId={projectId} />;
}

function ProjectFiles({ workspaceId, projectId }: { workspaceId: string | undefined; projectId: string }) {
  const projectBasePath = workspaceId ? `/workspaces/${workspaceId}/projects/${projectId}` : "..";
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
  const mounted = useRef(true);
  const librariesRef = useRef<FileLibrary[]>([]);
  const selectedLibraryRef = useRef<string | null>(null);
  const pathRef = useRef("");
  const libraryLoadVersion = useRef(0);
  const fileLoadVersion = useRef(0);
  const previewVersion = useRef(0);
  const previewRequest = useRef<InlinePreviewRequest | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);

  const [libraries, setLibraries] = useState<FileLibrary[]>([]);
  const [librariesState, setLibrariesState] = useState<LoadState>("loading");
  const [librariesMessage, setLibrariesMessage] = useState("");
  const [canCreateLibrary, setCanCreateLibrary] = useState(false);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [browser, dispatchBrowser] = useReducer(
    reduceFileBrowserState,
    createFileBrowserState([])
  );
  const browserRef = useRef(browser);
  browserRef.current = browser;
  const [operationMessage, setOperationMessage] = useState("");
  const [filesNotice, setFilesNotice] = useState("");
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [previewState, setPreviewState] = useState<FilePreviewState>({ status: "idle" });
  const [dropReady, setDropReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingFile, setDeletingFile] = useState(false);
  const [uploadFailure, setUploadFailure] = useState<{ libraryId: string; file: File; path: string; message: string; code?: string }>();
  const [replaceTarget, setReplaceTarget] = useState<{ libraryId: string; file: File; path: string }>();
  const [deleteFileTarget, setDeleteFileTarget] = useState<DeleteFileTarget>();
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<FileLibrary>();
  const [deleteLibraryTarget, setDeleteLibraryTarget] = useState<FileLibrary>();
  const [libraryName, setLibraryName] = useState("");
  const [libraryDialogError, setLibraryDialogError] = useState("");
  const [libraryDeleteError, setLibraryDeleteError] = useState("");
  const [replaceError, setReplaceError] = useState("");
  const [libraryMutationPending, setLibraryMutationPending] = useState(false);
  const [validatedReturnTo, setValidatedReturnTo] = useState<string | null>(null);

  const invalidateFileReads = useCallback(() => {
    fileLoadVersion.current += 1;
  }, []);

  const clearPreview = useCallback(() => {
    previewVersion.current += 1;
    previewRequest.current?.dispose();
    previewRequest.current = undefined;
    setPreviewState({ status: "idle" });
  }, []);

  const resetFileContext = useCallback(() => {
    dispatchBrowser({ type: "location_changed" });
    clearPreview();
    setMobileDetailsOpen(false);
  }, [clearPreview]);

  const applyLocation = useCallback((libraryId: string | null, nextPath: string) => {
    const changed = selectedLibraryRef.current !== libraryId || pathRef.current !== nextPath;
    if (changed) {
      invalidateFileReads();
      resetFileContext();
    }
    selectedLibraryRef.current = libraryId;
    pathRef.current = nextPath;
    setSelectedLibraryId(libraryId);
    setPath(nextPath);
    setUploadFailure(undefined);
    setReplaceTarget(undefined);
  }, [invalidateFileReads, resetFileContext]);

  const loadLibraries = useCallback(async () => {
    const version = ++libraryLoadVersion.current;
    setLibrariesState("loading");
    setLibrariesMessage("");
    const [libraryResult, capabilityResult] = await Promise.allSettled([
      apiClient.fileLibraries(projectId),
      apiClient.projectCapabilities(projectId)
    ]);
    if (!mounted.current || version !== libraryLoadVersion.current) return;
    if (capabilityResult.status === "fulfilled") {
      setCanCreateLibrary(capabilityResult.value.canWriteFiles);
    }
    if (libraryResult.status === "rejected") {
      setLibrariesMessage(errorMessage(libraryResult.reason, "File Libraries could not be loaded."));
      setLibrariesState("error");
      return;
    }
    const nextLibraries = libraryResult.value;
    librariesRef.current = nextLibraries;
    setLibraries(nextLibraries);
    setLibrariesState("ready");
    const currentId = selectedLibraryRef.current;
    const nextId = nextLibraries.some((library) => library.id === currentId) ? currentId : nextLibraries[0]?.id ?? null;
    const nextPath = nextId === currentId ? pathRef.current : "";
    applyLocation(nextId, nextPath);
    writeFileBrowserLocation(nextId, nextPath, true);
  }, [applyLocation, projectId]);

  useEffect(() => {
    mounted.current = true;
    const location = readFileBrowserLocation();
    if (workspaceId) {
      const scope = filesTaskReturnScope(window.location.pathname, workspaceId, projectId);
      setValidatedReturnTo((current) => filesReturnToAfterNavigation(
        current,
        new URLSearchParams(window.location.search).get("returnTo"),
        scope,
        "location"
      ));
    }
    selectedLibraryRef.current = location.libraryId;
    pathRef.current = location.path;
    setSelectedLibraryId(location.libraryId);
    setPath(location.path);
    void loadLibraries();
    return () => {
      mounted.current = false;
      libraryLoadVersion.current += 1;
      fileLoadVersion.current += 1;
      previewVersion.current += 1;
      previewRequest.current?.dispose();
      previewRequest.current = undefined;
    };
  }, [loadLibraries]);

  useEffect(() => {
    function restoreLocation() {
      const location = readFileBrowserLocation();
      if (workspaceId) {
        const scope = filesTaskReturnScope(window.location.pathname, workspaceId, projectId);
        setValidatedReturnTo((current) => filesReturnToAfterNavigation(
          current,
          new URLSearchParams(window.location.search).get("returnTo"),
          scope,
          "location"
        ));
      }
      const available = librariesRef.current;
      const nextId = available.length === 0 || available.some((library) => library.id === location.libraryId) ? location.libraryId : available[0]?.id ?? null;
      applyLocation(nextId, nextId === location.libraryId ? location.path : "");
    }
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, [applyLocation, projectId, workspaceId]);

  const loadFiles = useCallback(async () => {
    if (!selectedLibraryId) {
      dispatchBrowser({ type: "refresh_succeeded", entries: [] });
      return;
    }
    const requestedLibraryId = selectedLibraryId;
    const requestedPath = path;
    const version = ++fileLoadVersion.current;
    dispatchBrowser({ type: "refresh_started" });
    setOperationMessage("");
    setUploadFailure(undefined);
    try {
      const result = await apiClient.libraryFiles(projectId, requestedLibraryId, requestedPath);
      if (!mounted.current || version !== fileLoadVersion.current || selectedLibraryRef.current !== requestedLibraryId || pathRef.current !== requestedPath) return;
      const selectedPath = browserRef.current.selectedPath;
      if (selectedPath) {
        const currentSelected = browserRef.current.entries.find((entry) => entry.path === selectedPath);
        const refreshedSelected = result.entries.find((entry) => entry.path === selectedPath);
        if (!refreshedSelected) {
          clearPreview();
          setMobileDetailsOpen(false);
        } else if (currentSelected && fileEntryVersionChanged(currentSelected, refreshedSelected)) {
          clearPreview();
        }
      }
      dispatchBrowser({ type: "refresh_succeeded", entries: result.entries });
    } catch (error) {
      if (!mounted.current || version !== fileLoadVersion.current || selectedLibraryRef.current !== requestedLibraryId || pathRef.current !== requestedPath) return;
      dispatchBrowser({
        type: "refresh_failed",
        message: errorMessage(error, "Files could not be loaded.")
      });
    }
  }, [clearPreview, path, projectId, selectedLibraryId]);

  useEffect(() => {
    if (librariesState === "ready") void loadFiles();
  }, [librariesState, loadFiles]);

  const selectedLibrary = libraries.find((library) => library.id === selectedLibraryId);
  const selected = browser.entries.find((entry) => entry.path === browser.selectedPath);
  const page = useMemo(() => selectFileBrowserPage(browser), [browser]);
  const activePreviewPath =
    previewState.status === "ready"
      ? previewState.preview.path
      : previewState.status === "idle"
        ? null
        : previewState.path;
  const canWriteFiles = selectedLibrary?.capabilities.canWriteFiles === true;
  const mutationBusy = uploading || deletingFile || libraryMutationPending;

  function selectLibrary(libraryId: string) {
    if (libraryId === selectedLibraryRef.current) return;
    applyLocation(libraryId, "");
    writeFileBrowserLocation(libraryId, "", false);
  }

  function navigate(nextPath: string) {
    const normalized = normalizeLibraryPath(nextPath);
    if (normalized === pathRef.current) return;
    applyLocation(selectedLibraryRef.current, normalized);
    writeFileBrowserLocation(selectedLibraryRef.current, normalized, false);
  }

  function selectFile(entry: ProjectFile) {
    dispatchBrowser({ type: "selection_changed", path: entry.path });
    if (activePreviewPath !== entry.path) clearPreview();
    setMobileDetailsOpen(true);
  }

  function openDeleteFile(entry: ProjectFile) {
    if (!selectedLibrary) return;
    setDeleteFileTarget({ libraryId: selectedLibrary.id, entry });
  }

  function forgetFile(libraryId: string, filePath: string) {
    setDeleteFileTarget((current) => current?.libraryId === libraryId && current.entry.path === filePath ? undefined : current);
    if (selectedLibraryRef.current !== libraryId || pathRef.current !== parentLibraryPath(filePath)) return;
    invalidateFileReads();
    const selectedPath = browserRef.current.selectedPath;
    dispatchBrowser({ type: "entry_removed", path: filePath });
    if (selectedPath === filePath) {
      clearPreview();
      setMobileDetailsOpen(false);
    }
  }

  async function revokeWriteAccess(error: unknown, libraryId: string) {
    if (!isReadOnlyMutationError(error)) return false;
    const next = librariesRef.current.map((library) => library.id === libraryId ? { ...library, capabilities: { ...library.capabilities, canRename: false, canDelete: false, canWriteFiles: false } } : library);
    librariesRef.current = next;
    setLibraries(next);
    if (selectedLibraryRef.current === libraryId) {
      setUploadFailure(undefined);
      setReplaceTarget(undefined);
      setOperationMessage("File write access changed. This library is now read-only.");
    }
    return true;
  }

  async function upload(file: File, overwrite = false, uploadPath = path, libraryId = selectedLibraryRef.current) {
    const library = librariesRef.current.find((candidate) => candidate.id === libraryId);
    if (!libraryId || !library?.capabilities.canWriteFiles || selectedLibraryRef.current !== libraryId || uploading || deletingFile) {
      setUploadFailure(undefined);
      setReplaceTarget(undefined);
      return;
    }
    setUploading(true);
    setUploadFailure(undefined);
    setOperationMessage("");
    const filePath = childLibraryPath(uploadPath, file.name);
    const requestIdentity = `${libraryId}:${filePath}:${overwrite}:${file.size}:${file.lastModified}`;
    try {
      const written = await apiClient.uploadLibraryFile(projectId, libraryId, filePath, file, { overwrite, idempotencyKey: mutationKeys.key("library-file.upload", requestIdentity) });
      mutationKeys.complete("library-file.upload", requestIdentity);
      if (!mounted.current) return;
      const entry: ProjectFile = { name: written.path.slice(written.path.lastIndexOf("/") + 1), path: written.path, type: "file", size: written.bytes, mediaType: written.mediaType, updatedAt: written.updatedAt };
      if (selectedLibraryRef.current === libraryId && pathRef.current === uploadPath) {
        invalidateFileReads();
        if (overwrite && browserRef.current.selectedPath === written.path) clearPreview();
        dispatchBrowser({ type: "entry_upserted", entry });
      }
      if (overwrite) {
        setReplaceTarget(undefined);
        setReplaceError("");
      }
      showToast({ body: overwrite ? "File replaced" : "File uploaded", type: "info" });
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError) mutationKeys.complete("library-file.upload", requestIdentity);
      if (await revokeWriteAccess(error, libraryId)) return;
      if (selectedLibraryRef.current !== libraryId) return;
      if (!overwrite && error instanceof ApiError && error.status === 409 && error.message === "Project file already exists") {
        setReplaceError("");
        setReplaceTarget({ libraryId, file, path: uploadPath });
      } else if (overwrite) {
        setReplaceError(errorMessage(error, "File could not be replaced."));
      } else {
        setUploadFailure({ libraryId, file, path: uploadPath, message: errorMessage(error, "File could not be uploaded."), ...(error instanceof ApiError && error.code ? { code: error.code } : {}) });
      }
    } finally {
      if (mounted.current) setUploading(false);
    }
  }

  function selectUpload(selection: File | File[] | null) {
    const file = Array.isArray(selection) ? selection[0] : selection;
    if (file) void upload(file);
  }

  async function openPreview(entry: ProjectFile) {
    if (entry.type !== "file" || !selectedLibrary) return;
    const libraryId = selectedLibrary.id;
    const version = ++previewVersion.current;
    previewRequest.current?.dispose();
    setPreviewState({ status: "loading", path: entry.path });
    const request = createInlinePreviewRequest({
      mediaType: entry.mediaType,
      bytes: entry.size ?? 0,
      byteLimits: filePreviewByteLimits,
      load: (signal) => apiClient.previewLibraryFile(projectId, libraryId, entry.path, signal)
    });
    previewRequest.current = request;
    try {
      const preview = await request.result;
      if (!mounted.current || version !== previewVersion.current || selectedLibraryRef.current !== libraryId) return;
      setPreviewState({ status: "ready", preview: { ...preview, name: entry.name, path: entry.path } });
    } catch (error) {
      if (!mounted.current || version !== previewVersion.current) return;
      if (isMissingFile(error)) {
        request.dispose();
        if (previewRequest.current === request) previewRequest.current = undefined;
        forgetFile(libraryId, entry.path);
        setFilesNotice("File no longer exists. It was removed from this File Library view.");
        return;
      }
      request.dispose();
      if (previewRequest.current === request) previewRequest.current = undefined;
      setPreviewState({
        status: "error",
        path: entry.path,
        message: errorMessage(error, "File preview could not be loaded.")
      });
    }
  }

  async function removeFile() {
    if (!deleteFileTarget || uploading || deletingFile) return;
    const target = deleteFileTarget;
    const libraryId = target.libraryId;
    const requestIdentity = `${libraryId}:${target.entry.path}`;
    setDeletingFile(true);
    try {
      let alreadyMissing = false;
      await apiClient.deleteLibraryFile(projectId, libraryId, target.entry.path, mutationKeys.key("library-file.delete", requestIdentity)).catch((error) => {
        if (!isMissingFile(error)) throw error;
        alreadyMissing = true;
      });
      mutationKeys.complete("library-file.delete", requestIdentity);
      if (!mounted.current) return;
      const targetIsCurrent = selectedLibraryRef.current === libraryId && pathRef.current === parentLibraryPath(target.entry.path);
      setDeleteFileTarget(undefined);
      forgetFile(libraryId, target.entry.path);
      if (alreadyMissing && targetIsCurrent) setFilesNotice("File no longer exists. The File Library view has been updated.");
      else if (alreadyMissing) showToast({ body: "File no longer exists", type: "info" });
      else showToast({ body: "File deleted", type: "info" });
    } catch (error) {
      if (error instanceof ApiError) mutationKeys.complete("library-file.delete", requestIdentity);
      await revokeWriteAccess(error, libraryId);
      throw new Error(errorMessage(error, "File could not be deleted."));
    } finally {
      if (mounted.current) setDeletingFile(false);
    }
  }

  function openCreateLibrary() {
    setLibraryName("");
    setLibraryDialogError("");
    setCreateOpen(true);
  }

  function openRenameLibrary(library: FileLibrary) {
    setLibraryName(library.name);
    setLibraryDialogError("");
    setRenameTarget(library);
  }

  async function createLibrary(event: FormEvent) {
    event.preventDefault();
    const name = libraryName.trim();
    if (!name || libraryMutationPending) return;
    const requestIdentity = name;
    setLibraryMutationPending(true);
    setLibraryDialogError("");
    try {
      const created = await apiClient.createFileLibrary(projectId, name, mutationKeys.key("file-library.create", requestIdentity));
      mutationKeys.complete("file-library.create", requestIdentity);
      const next = [...librariesRef.current, created];
      librariesRef.current = next;
      setLibraries(next);
      setCreateOpen(false);
      selectLibrary(created.id);
      showToast({ body: "File Library created", type: "info" });
    } catch (error) {
      if (error instanceof ApiError) mutationKeys.complete("file-library.create", requestIdentity);
      setLibraryDialogError(errorMessage(error, "File Library could not be created."));
    } finally {
      if (mounted.current) setLibraryMutationPending(false);
    }
  }

  async function renameLibrary(event: FormEvent) {
    event.preventDefault();
    if (!renameTarget || libraryMutationPending) return;
    const name = libraryName.trim();
    if (!name) return;
    const target = renameTarget;
    const requestIdentity = `${target.id}:${target.updatedAt}:${name}`;
    setLibraryMutationPending(true);
    setLibraryDialogError("");
    try {
      const renamed = await apiClient.renameFileLibrary(projectId, target.id, { name, expectedUpdatedAt: target.updatedAt }, mutationKeys.key("file-library.rename", requestIdentity));
      mutationKeys.complete("file-library.rename", requestIdentity);
      const next = librariesRef.current.map((library) => library.id === renamed.id ? renamed : library);
      librariesRef.current = next;
      setLibraries(next);
      setRenameTarget(undefined);
      showToast({ body: "File Library renamed", type: "info" });
    } catch (error) {
      if (error instanceof ApiError) mutationKeys.complete("file-library.rename", requestIdentity);
      setLibraryDialogError(errorMessage(error, "File Library could not be renamed."));
    } finally {
      if (mounted.current) setLibraryMutationPending(false);
    }
  }

  async function deleteLibrary() {
    if (!deleteLibraryTarget || libraryMutationPending) return;
    const target = deleteLibraryTarget;
    const requestIdentity = target.id;
    setLibraryMutationPending(true);
    setLibraryDeleteError("");
    try {
      await apiClient.deleteFileLibrary(projectId, target.id, mutationKeys.key("file-library.delete", requestIdentity));
      mutationKeys.complete("file-library.delete", requestIdentity);
      const current = librariesRef.current;
      const deletedIndex = current.findIndex((library) => library.id === target.id);
      const next = current.filter((library) => library.id !== target.id);
      librariesRef.current = next;
      setLibraries(next);
      setDeleteLibraryTarget(undefined);
      const fallback = next[Math.min(Math.max(deletedIndex, 0), next.length - 1)]?.id ?? null;
      applyLocation(fallback, "");
      writeFileBrowserLocation(fallback, "", true);
      showToast({ body: "File Library deleted", type: "info" });
    } catch (error) {
      if (error instanceof ApiError) mutationKeys.complete("file-library.delete", requestIdentity);
      setLibraryDeleteError(errorMessage(error, "File Library could not be deleted."));
    } finally {
      if (mounted.current) setLibraryMutationPending(false);
    }
  }

  const parent = parentLibraryPath(path);
  const crumbs = libraryBreadcrumbs(selectedLibrary?.name ?? "File Library", path);
  const noMatches = browser.entries.length > 0 && browser.query.trim().length > 0 && page.totalCount === 0;
  const initialFilesLoading = browser.entries.length === 0 && (browser.loadState === "idle" || browser.loadState === "loading");
  const initialFilesError = browser.entries.length === 0 && browser.loadState === "error";
  const returnTo = validatedReturnTo;

  return <PageLayout contentWidth="full" header={<PageHeader title="Files" subtitle="Browse and manage the File Libraries available in this project." actions={<div className="flex items-center gap-2"><IconButton label="Refresh File Libraries" tooltip="Refresh File Libraries" variant="ghost" icon={<RefreshCw size={16} />} onClick={() => void loadLibraries()} isDisabled={librariesState === "loading" || mutationBusy} />{canCreateLibrary ? <Button label="Create library" variant="primary" size="lg" icon={<Plus size={16} />} onClick={openCreateLibrary} /> : null}</div>} />}>
    {returnTo ? <Link className="inline-flex w-fit items-center gap-2 hover:text-primary" href={returnTo}><ArrowLeft size={16} /><Text type="supporting" color="secondary">Back to Task</Text></Link> : null}
    <MobileLibraryControls libraries={libraries} selectedLibrary={selectedLibrary} state={librariesState} message={librariesMessage} canCreate={canCreateLibrary} mutationBusy={mutationBusy} onRetry={loadLibraries} onSelect={selectLibrary} onCreate={openCreateLibrary} onRename={openRenameLibrary} onDelete={setDeleteLibraryTarget} />
    <div className="grid min-h-[34rem] gap-4 lg:grid-cols-[16rem_minmax(0,1fr)_19rem]">
      <LibrariesPane state={librariesState} message={librariesMessage} libraries={libraries} selectedLibraryId={selectedLibraryId} projectBasePath={projectBasePath} canCreate={canCreateLibrary} mutationBusy={mutationBusy} onRetry={loadLibraries} onSelect={selectLibrary} onCreate={openCreateLibrary} onRename={openRenameLibrary} onDelete={setDeleteLibraryTarget} />
      <section className={`min-w-0 overflow-hidden rounded-md border bg-surface ${dropReady ? "border-accent ring-2 ring-accent" : "border-border"}`} aria-label="Library files" aria-busy={browser.loadState === "loading"} onDragEnter={(event) => { event.preventDefault(); if (canWriteFiles && !mutationBusy) setDropReady(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropReady(false); }} onDrop={(event) => { event.preventDefault(); setDropReady(false); if (!canWriteFiles || mutationBusy) return; const dropped = event.dataTransfer.files?.[0]; if (dropped) void upload(dropped); }}>
        {!selectedLibrary ? <NoLibrarySelected canCreate={canCreateLibrary} onCreate={openCreateLibrary} /> : <>
          <p className="sr-only" aria-live="polite">{dropReady ? "Drop a file to upload" : ""}</p>
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-3">
            <nav className="min-w-0 overflow-x-auto" aria-label="Library path"><ol className="flex min-w-max items-center gap-1 text-secondary">{crumbs.map((crumb, index) => <li className="flex items-center gap-1" key={crumb.path}>{index > 0 ? <ChevronRight className="size-4 text-icon-secondary" aria-hidden="true" /> : null}<button type="button" className="max-w-56 truncate rounded-sm px-1.5 py-1 hover:bg-overlay-hover hover:text-primary" title={crumb.label} onClick={() => navigate(crumb.path)}><Text type="supporting" color="secondary">{crumb.label}</Text></button></li>)}</ol></nav>
            <div className="flex shrink-0 items-center gap-1"><IconButton label="Refresh files" tooltip="Refresh files" variant="ghost" icon={<RefreshCw size={15} />} onClick={() => void loadFiles()} isDisabled={browser.loadState === "loading" || mutationBusy} />{canWriteFiles ? <FileInput ref={input} label="Upload file" isLabelHidden value={null} onChange={selectUpload} placeholder={uploading ? "Uploading" : "Upload"} isDisabled={mutationBusy} isLoading={uploading} width={128} /> : null}</div>
          </div>
          <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row">
            <TextInput label="Filter files" isLabelHidden startIcon={<Search size={16} />} value={browser.query} onChange={(query) => dispatchBrowser({ type: "filter_changed", query })} hasClear placeholder="Filter files" size="lg" width="100%" />
            <Selector label="Sort files" isLabelHidden options={fileSortOptions} value={`${browser.sort.field}:${browser.sort.direction}`} onChange={(value) => { const [field, direction] = value.split(":") as [FileBrowserSort["field"], FileBrowserSort["direction"]]; dispatchBrowser({ type: "sort_changed", sort: { field, direction } }); }} size="lg" className="w-full shrink-0 sm:w-44" />
          </div>
          {filesNotice ? <Banner className="mx-3 mt-3" status="info" title="File Library updated" description={filesNotice} isDismissable onDismiss={() => setFilesNotice("")} /> : null}
          {operationMessage ? <InlineError message={operationMessage} onDismiss={() => setOperationMessage("")} /> : null}
          {browser.loadState === "error" && browser.entries.length > 0 ? <Banner className="mx-3 mt-3" status="error" title="Files could not be refreshed" description={browser.message} endContent={<Button label="Try again" variant="ghost" size="sm" onClick={() => void loadFiles()} />} /> : null}
          {uploadFailure ? <Banner className="mx-3 mt-3" status="error" title={uploadFailure.code === "project_file_bytes_limit_reached" ? "File storage limit reached" : "File upload failed"} description={uploadFailure.code === "project_file_bytes_limit_reached" ? <>Delete files or ask a project administrator to change the limit. <Link className="underline" href={`${projectBasePath}/policy`}><Text weight="medium">Open resource policy</Text></Link>.</> : uploadFailure.message} endContent={<div className="flex shrink-0 gap-1">{uploadFailure.code !== "project_file_bytes_limit_reached" ? <Button label="Retry upload" variant="ghost" size="md" onClick={() => void upload(uploadFailure.file, false, uploadFailure.path, uploadFailure.libraryId)} isDisabled={mutationBusy} /> : null}<IconButton label="Refresh files" tooltip="Refresh files" variant="ghost" icon={<RefreshCw size={15} />} onClick={() => void loadFiles()} isDisabled={mutationBusy} /></div>} /> : null}
          {initialFilesLoading ? <FileBrowserLoading /> : null}
          {initialFilesError ? <FileBrowserError message={browser.message} onRetry={loadFiles} /> : null}
          {browser.loadState === "ready" && browser.entries.length === 0 ? <FileBrowserEmpty nested={path !== ""} canUpload={canWriteFiles} onUpload={() => input.current?.click()} /> : null}
          {noMatches ? <FileBrowserNoMatches query={browser.query.trim()} onClear={() => dispatchBrowser({ type: "filter_changed", query: "" })} /> : null}
          {browser.entries.length > 0 && !noMatches ? <FileBrowserList entries={page.entries} parent={parent} selectedPath={browser.selectedPath} onNavigate={navigate} onSelect={selectFile} /> : null}
          {page.totalCount > 0 ? <FileBrowserPagination page={page.page} pageCount={page.pageCount} range={page.range} totalCount={page.totalCount} onPageChange={(nextPage) => dispatchBrowser({ type: "page_changed", page: nextPage })} /> : null}
        </>}
      </section>
      <aside className="hidden rounded-md border border-border bg-surface p-4 lg:block"><FileDetails entry={selected} projectId={projectId} library={selectedLibrary} mutationBusy={mutationBusy} previewState={previewState} onDelete={openDeleteFile} onPreview={openPreview} onClosePreview={clearPreview} /></aside>
    </div>
    <div className="lg:hidden">{selected ? <Collapsible trigger="File details" isOpen={mobileDetailsOpen} onOpenChange={setMobileDetailsOpen}><div className="mt-2 rounded-md border border-border bg-surface p-4"><FileDetails entry={selected} projectId={projectId} library={selectedLibrary} mutationBusy={mutationBusy} previewState={previewState} onDelete={openDeleteFile} onPreview={openPreview} onClosePreview={clearPreview} /></div></Collapsible> : null}</div>
    <LibraryNameDialog mode="create" open={createOpen} name={libraryName} error={libraryDialogError} pending={libraryMutationPending} onOpenChange={(open) => { if (!libraryMutationPending) { setCreateOpen(open); if (!open) setLibraryDialogError(""); } }} onNameChange={setLibraryName} onSubmit={createLibrary} />
    <LibraryNameDialog mode="rename" open={Boolean(renameTarget)} name={libraryName} error={libraryDialogError} pending={libraryMutationPending} onOpenChange={(open) => { if (!open && !libraryMutationPending) { setRenameTarget(undefined); setLibraryDialogError(""); } }} onNameChange={setLibraryName} onSubmit={renameLibrary} />
    <DeleteLibraryDialog library={deleteLibraryTarget} pending={libraryMutationPending} error={libraryDeleteError} onOpenChange={(open) => { if (!open && !libraryMutationPending) { setDeleteLibraryTarget(undefined); setLibraryDeleteError(""); } }} onConfirm={deleteLibrary} />
    <DeleteFileDialog entry={deleteFileTarget?.entry} deleting={deletingFile} onCancel={() => !deletingFile && setDeleteFileTarget(undefined)} onConfirm={removeFile} />
    <ReplaceFileDialog target={replaceTarget} pending={uploading} error={replaceError} onOpenChange={(open) => { if (!open && !uploading) { setReplaceTarget(undefined); setReplaceError(""); } }} onConfirm={() => replaceTarget ? upload(replaceTarget.file, true, replaceTarget.path, replaceTarget.libraryId) : undefined} />
  </PageLayout>;
}

function MobileLibraryControls({ libraries, selectedLibrary, state, message, canCreate, mutationBusy, onRetry, onSelect, onCreate, onRename, onDelete }: { libraries: FileLibrary[]; selectedLibrary: FileLibrary | undefined; state: LoadState; message: string; canCreate: boolean; mutationBusy: boolean; onRetry: () => Promise<void>; onSelect: (id: string) => void; onCreate: () => void; onRename: (library: FileLibrary) => void; onDelete: (library: FileLibrary) => void }) {
  return <section className="mb-4 space-y-2 lg:hidden" aria-label="File Library selection">
    <div className="flex items-end gap-1">
      <Selector label="File Library" options={libraries.map((library) => ({ value: library.id, label: library.name }))} value={selectedLibrary?.id ?? ""} onChange={onSelect} placeholder={state === "loading" ? "Loading libraries" : "Select a library"} isDisabled={libraries.length === 0 || mutationBusy} size="lg" className="min-w-0 flex-1" />
      {canCreate ? <IconButton label="Create library" tooltip="Create File Library" variant="ghost" size="lg" icon={<Plus size={16} />} onClick={onCreate} isDisabled={mutationBusy} /> : null}
      {selectedLibrary ? <IconButton label={`Rename ${selectedLibrary.name}`} tooltip={selectedLibrary.capabilities.canRename ? "Rename File Library" : "You do not have permission to rename this library"} variant="ghost" size="lg" icon={<Pencil size={15} />} isDisabled={!selectedLibrary.capabilities.canRename || mutationBusy} onClick={() => onRename(selectedLibrary)} /> : null}
      {selectedLibrary ? <IconButton label={`Delete ${selectedLibrary.name}`} tooltip={selectedLibrary.boundTask ? "This library is bound to a Task and cannot be deleted" : selectedLibrary.capabilities.canDelete ? "Delete File Library" : "You do not have permission to delete this library"} variant="destructive" size="lg" icon={<Trash2 size={15} />} isDisabled={!selectedLibrary.capabilities.canDelete || mutationBusy} onClick={() => onDelete(selectedLibrary)} /> : null}
    </div>
    {state === "error" ? <Banner status="error" title="Libraries could not be refreshed" description={message} endContent={<Button label="Try again" variant="ghost" size="sm" onClick={() => void onRetry()} />} /> : null}
  </section>;
}

function LibrariesPane({ state, message, libraries, selectedLibraryId, projectBasePath, canCreate, mutationBusy, onRetry, onSelect, onCreate, onRename, onDelete }: { state: LoadState; message: string; libraries: FileLibrary[]; selectedLibraryId: string | null; projectBasePath: string; canCreate: boolean; mutationBusy: boolean; onRetry: () => Promise<void>; onSelect: (id: string) => void; onCreate: () => void; onRename: (library: FileLibrary) => void; onDelete: (library: FileLibrary) => void }) {
  return <section className="hidden min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface lg:flex" aria-label="File Libraries">
    <div className="flex min-h-12 items-center justify-between border-b border-border px-3"><div className="min-w-0"><Heading level={3} accessibilityLevel={2}>File Libraries</Heading><Text type="supporting" color="secondary" display="block" className="mt-0.5">{libraries.length} {libraries.length === 1 ? "library" : "libraries"}</Text></div>{canCreate ? <IconButton label="Create library" tooltip="Create library" variant="ghost" icon={<Plus size={16} />} onClick={onCreate} isDisabled={mutationBusy} /> : null}</div>
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
      {state === "loading" && libraries.length === 0 ? <div className="space-y-2 p-1.5" aria-label="Loading File Libraries"><Skeleton height={48} /><Skeleton height={48} /></div> : null}
      {state === "error" ? <Banner status="error" title="Libraries could not be refreshed" description={message} endContent={<Button label="Try again" variant="ghost" size="sm" onClick={() => void onRetry()} />} /> : null}
      {state === "ready" && libraries.length === 0 ? <EmptyState isCompact title="No File Libraries available" /> : null}
      {libraries.map((library) => {
        const active = library.id === selectedLibraryId;
        const boundLabel = library.boundTask ? `Bound to ${library.boundTask.title || "Task"}` : null;
        return <div key={library.id} className={`group flex items-center gap-1 rounded-sm ${active ? "bg-accent-muted ring-1 ring-inset ring-accent" : "hover:bg-overlay-hover"}`}>
          <div className="min-w-0 flex-1 py-2"><button type="button" className="flex w-full min-w-0 items-center gap-2 px-2 text-left" aria-current={active ? "true" : undefined} aria-label={`Select library ${library.name}`} onClick={() => onSelect(library.id)} title={library.name}><FolderOpen className={`size-4 shrink-0 ${active ? "text-accent-text" : "text-icon-secondary"}`} /><Text maxLines={1}>{library.name}</Text></button>{library.boundTask && boundLabel ? <Link className="mt-1 block truncate pl-8 pr-2 text-warning hover:underline" href={`${projectBasePath}/tasks/${encodeURIComponent(library.boundTask.id)}`} title={boundLabel}><Text type="supporting" color="inherit">{boundLabel}</Text></Link> : <Text type="supporting" color="secondary" display="block" className="mt-1 pl-8">Available</Text>}</div>
          {active ? <div className="flex shrink-0 items-center pr-1"><IconButton label={`Rename ${library.name}`} tooltip={library.capabilities.canRename ? "Rename File Library" : "You do not have permission to rename this library"} variant="ghost" className="h-7 w-7" icon={<Pencil size={14} />} isDisabled={!library.capabilities.canRename || mutationBusy} onClick={() => onRename(library)} /><IconButton label={`Delete ${library.name}`} tooltip={library.boundTask ? "This library is bound to a Task and cannot be deleted" : library.capabilities.canDelete ? "Delete File Library" : "You do not have permission to delete this library"} variant="destructive" className="h-7 w-7 text-error" icon={<Trash2 size={14} />} isDisabled={!library.capabilities.canDelete || mutationBusy} onClick={() => onDelete(library)} /></div> : null}
        </div>;
      })}
    </div>
  </section>;
}

function NoLibrarySelected({ canCreate, onCreate }: { canCreate: boolean; onCreate: () => void }) {
  return <EmptyState className="min-h-[28rem]" icon={<FolderOpen />} title="No File Libraries" description="Create a File Library to store and browse files for this project." {...(canCreate ? { actions: <Button label="Create library" variant="primary" size="lg" icon={<Plus size={16} />} onClick={onCreate} /> } : {})} />;
}

function LibraryNameDialog({ mode, open, name, error, pending, onOpenChange, onNameChange, onSubmit }: { mode: "create" | "rename"; open: boolean; name: string; error: string; pending: boolean; onOpenChange: (open: boolean) => void; onNameChange: (name: string) => void; onSubmit: (event: FormEvent) => void }) {
  const create = mode === "create";
  const title = create ? "Create File Library" : "Rename File Library";
  const subtitle = create ? "Libraries keep project files organized and can be assigned to Tasks." : "The library root and its files will not move.";
  const handleOpenChange = (next: boolean) => { if (!pending) onOpenChange(next); };
  const formId = useId();
  return <Dialog isOpen={open} onOpenChange={handleOpenChange} title={title} subtitle={subtitle} busy={pending} primaryAction={<Button label={create ? "Create" : "Save"} type="submit" form={formId} variant="primary" size="lg" isLoading={pending} isDisabled={pending || !name.trim()} />}>{error ? <Banner className="mb-4" status="error" title={create ? "File Library could not be created" : "File Library could not be renamed"} description={error} /> : null}<form id={formId} onSubmit={onSubmit}><TextInput label="Library name" value={name} onChange={(value) => onNameChange(value.slice(0, 120))} isRequired hasAutoFocus isDisabled={pending} width="100%" /></form></Dialog>;
}

function InlineError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return <Banner className="mx-3 mt-3" status="error" title="File operation unavailable" description={message} isDismissable onDismiss={onDismiss} />;
}

function FileBrowserLoading() {
  return <div className="space-y-2 p-3" aria-label="Loading files"><Skeleton height={40} /><Skeleton height={40} /><Skeleton height={40} /></div>;
}

function FileBrowserError({ message, onRetry }: { message: string; onRetry: () => Promise<unknown> }) {
  return <Banner className="m-3" status="error" title="Files unavailable" description={message} endContent={<Button label="Try again" variant="ghost" size="sm" onClick={() => void onRetry()} />} />;
}

function FileBrowserEmpty({ nested, canUpload, onUpload }: { nested: boolean; canUpload: boolean; onUpload: () => void }) {
  return <EmptyState className="min-h-64" icon={<FolderUp />} title={nested ? "This folder is empty" : "No files yet"} description={nested ? "Use the path trail to return to another folder." : "Upload a file to this library."} {...(canUpload ? { actions: <Button label="Upload file" variant="secondary" size="lg" icon={<Upload size={16} />} onClick={onUpload} /> } : {})} />;
}

function FileBrowserNoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return <EmptyState className="min-h-64" icon={<Search />} title="No matching files" description={`No files in this folder match "${query}".`} actions={<Button label="Clear filter" variant="ghost" size="lg" onClick={onClear} />} />;
}

function FileBrowserList({ entries, parent, selectedPath, onNavigate, onSelect }: { entries: ProjectFile[]; parent: string | null; selectedPath: string | null; onNavigate: (path: string) => void; onSelect: (entry: ProjectFile) => void }) {
  return <div className="divide-y divide-border">{parent !== null ? <button type="button" className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 text-left text-secondary hover:bg-overlay-hover hover:text-primary" onClick={() => onNavigate(parent)}><FolderUp className="size-5" /><span>Up one folder</span><Text type="supporting" color="secondary">..</Text></button> : null}{entries.map((entry) => <FileRow key={entry.path} entry={entry} selected={entry.path === selectedPath} onNavigate={onNavigate} onSelect={onSelect} />)}</div>;
}

function FileBrowserPagination({ page, pageCount, range, totalCount, onPageChange }: { page: number; pageCount: number; range: { start: number; end: number }; totalCount: number; onPageChange: (page: number) => void }) {
  return <div className="flex min-h-12 items-center justify-between gap-3 border-t border-border px-3">
    <Text type="supporting" color="secondary">{range.start}-{range.end} of {totalCount}</Text>
    <div className="flex items-center gap-1">
      <IconButton label="Previous page" tooltip="Previous page" variant="ghost" size="md" icon={<ChevronLeft size={16} />} isDisabled={page === 1} onClick={() => onPageChange(page - 1)} />
      <Text type="supporting" color="secondary">Page {page} of {pageCount}</Text>
      <IconButton label="Next page" tooltip="Next page" variant="ghost" size="md" icon={<ChevronRight size={16} />} isDisabled={page === pageCount} onClick={() => onPageChange(page + 1)} />
    </div>
  </div>;
}

function FileRow({ entry, selected, onNavigate, onSelect }: { entry: ProjectFile; selected: boolean; onNavigate: (path: string) => void; onSelect: (entry: ProjectFile) => void }) {
  const directory = entry.type === "directory";
  return <div className={`grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 ${selected ? "bg-muted" : "hover:bg-overlay-hover"}`}><span className="text-icon-secondary">{directory ? <Folder className="size-5" /> : <FileText className="size-5" />}</span><button type="button" className="min-w-0 truncate text-left text-primary" title={entry.name} onClick={() => directory ? onNavigate(entry.path) : onSelect(entry)}><Text type="supporting">{entry.name}</Text></button><button type="button" className="rounded-sm px-2 py-1 text-secondary hover:bg-overlay-hover hover:text-primary" aria-label={`Show details for ${entry.name}`} onClick={() => onSelect(entry)}><Text type="supporting" color="secondary">{directory ? "Folder" : formatBytes(entry.size ?? 0)}</Text></button></div>;
}

function FileDetails({ entry, projectId, library, mutationBusy, previewState, onDelete, onPreview, onClosePreview }: { entry: ProjectFile | undefined; projectId: string; library: FileLibrary | undefined; mutationBusy: boolean; previewState: FilePreviewState; onDelete: (entry: ProjectFile) => void; onPreview: (entry: ProjectFile) => void; onClosePreview: () => void }) {
  if (!entry || !library) return <EmptyState className="min-h-48" isCompact title="No file selected" description="Select a file to view its details." />;
  const file = entry.type === "file";
  const previewForEntry =
    (previewState.status === "ready" && previewState.preview.path === entry.path) ||
    (previewState.status !== "idle" && previewState.status !== "ready" && previewState.path === entry.path);
  return <div className="space-y-4">
    <div><Text type="supporting" color="secondary" display="block">{file ? "File" : "Folder"}</Text><Heading level={2} className="mt-2 break-words">{entry.name}</Heading><Text as="p" type="supporting" color="secondary" display="block" wordBreak="break-all" className="mt-1">{entry.path}</Text></div>
    <dl className="space-y-3 border-y border-border py-3"><div className="flex justify-between gap-3"><dt><Text type="supporting" color="secondary">Size</Text></dt><dd><Text type="supporting">{file ? formatBytes(entry.size ?? 0) : "-"}</Text></dd></div>{file ? <div className="flex justify-between gap-3"><dt><Text type="supporting" color="secondary">Type</Text></dt><dd className="break-all text-right"><Text type="code">{entry.mediaType ?? "application/octet-stream"}</Text></dd></div> : null}<div className="flex justify-between gap-3"><dt><Text type="supporting" color="secondary">Updated</Text></dt><dd className="text-right"><Text type="supporting">{formatDate(entry.updatedAt)}</Text></dd></div></dl>
    {file ? <div className="flex flex-wrap gap-2"><Button as="a" label="Download" href={apiClient.libraryFileDownloadUrl(projectId, library.id, entry.path)} variant="secondary" size="lg" icon={<Download size={16} />}/>{isInlinePreviewAvailable({ mediaType: entry.mediaType, bytes: entry.size ?? 0 }, filePreviewByteLimits) ? <Button label="Preview" variant="secondary" size="lg" icon={<Image size={16} />} isLoading={previewState.status === "loading" && previewState.path === entry.path} onClick={() => onPreview(entry)} /> : null}{library.capabilities.canWriteFiles ? <Button label="Delete" variant="destructive" size="lg" icon={<Trash2 size={16} />} isDisabled={mutationBusy} onClick={() => onDelete(entry)} /> : null}</div> : null}
    {previewForEntry ? <FilePreviewPanel state={previewState} entry={entry} onRetry={() => onPreview(entry)} onClose={onClosePreview} /> : null}
  </div>;
}

function FilePreviewPanel({ state, entry, onRetry, onClose }: { state: FilePreviewState; entry: ProjectFile; onRetry: () => void; onClose: () => void }) {
  return <section className="h-64 overflow-hidden border-t border-border pt-3" aria-label={`Preview ${entry.name}`}>
    <div className="mb-2 flex h-8 items-center justify-between gap-2">
      <Text weight="semibold" maxLines={1}>Preview</Text>
      <IconButton label="Close preview" tooltip="Close preview" variant="ghost" size="sm" icon={<X size={14} />} onClick={onClose} />
    </div>
    <div className="h-48 min-h-0 overflow-auto">
      {state.status === "loading" ? <div className="space-y-2" aria-label="Loading file preview"><Skeleton height={32} /><Skeleton height={120} /></div> : null}
      {state.status === "error" ? <Banner status="error" title="File preview unavailable" description={state.message} endContent={<Button label="Try again" variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={onRetry} />} /> : null}
      {state.status === "ready" && state.preview.kind === "image" ? <div className="grid h-full place-items-center"><img className="max-h-full max-w-full object-contain" src={state.preview.url} alt={state.preview.name} /></div> : null}
      {state.status === "ready" && state.preview.kind === "text" ? <pre className="min-h-full whitespace-pre-wrap break-words"><Text type="code">{state.preview.text}</Text></pre> : null}
    </div>
  </section>;
}

export function DeleteFileDialog({ entry, deleting, onCancel, onConfirm }: { entry: ProjectFile | undefined; deleting: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [error, setError] = useState("");
  useEffect(() => setError(""), [entry?.path]);
  async function confirm() {
    setError("");
    try {
      await onConfirm();
    } catch (cause) {
      setError(errorMessage(cause, "File could not be deleted."));
    }
  }
  const handleOpenChange = (open: boolean) => {
    if (!open && !deleting) {
      setError("");
      onCancel();
    }
  };
  return <ConfirmationDialog isOpen={entry !== undefined} onOpenChange={handleOpenChange} title="Delete file?" description={<Text as="p" color="secondary">This permanently removes the file from this File Library.</Text>} actionLabel="Delete" busy={deleting} onAction={() => void confirm()}>{entry ? <Text as="p" display="block">File: <Text weight="semibold">{entry.name}</Text></Text> : null}{error ? <Banner status="error" title="File could not be deleted" description={error} /> : null}</ConfirmationDialog>;
}

function DeleteLibraryDialog({ library, pending, error, onOpenChange, onConfirm }: { library: FileLibrary | undefined; pending: boolean; error: string; onOpenChange: (open: boolean) => void; onConfirm: () => Promise<void> }) {
  const handleOpenChange = (open: boolean) => !pending && onOpenChange(open);
  return <ConfirmationDialog isOpen={Boolean(library)} onOpenChange={handleOpenChange} title="Delete File Library?" description={<Text as="p" color="secondary">The server will only delete an unbound, empty library.</Text>} actionLabel="Delete library" busy={pending} onAction={() => void onConfirm()}>{library ? <Text as="p" display="block">Library: <Text weight="semibold">{library.name}</Text></Text> : null}{error ? <Banner status="error" title="File Library could not be deleted" description={error} /> : null}</ConfirmationDialog>;
}

function ReplaceFileDialog({ target, pending, error, onOpenChange, onConfirm }: { target: { file: File } | undefined; pending: boolean; error: string; onOpenChange: (open: boolean) => void; onConfirm: () => Promise<void> | undefined }) {
  const handleOpenChange = (open: boolean) => !pending && onOpenChange(open);
  return <ConfirmationDialog isOpen={Boolean(target)} onOpenChange={handleOpenChange} title={`Replace ${target?.file.name ?? "file"}?`} description={<Text as="p" color="secondary">A file with this name already exists in this folder. This permanently replaces its contents.</Text>} actionLabel="Replace file" actionVariant="primary" busy={pending} onAction={() => void onConfirm()}>{error ? <Banner status="error" title="File could not be replaced" description={error} /> : null}</ConfirmationDialog>;
}

function normalizeLibraryPath(input: string | null | undefined): string {
  if (!input) return "";
  if (input.includes("\\")) return "";
  const segments = input.split("/");
  return segments.some((segment) => !segment || segment === "." || segment === "..") ? "" : segments.join("/");
}

function parentLibraryPath(path: string): string | null {
  if (!path) return null;
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function childLibraryPath(path: string, name: string): string {
  return path ? `${path}/${name}` : name;
}

function libraryBreadcrumbs(libraryName: string, path: string): Array<{ label: string; path: string }> {
  const crumbs = [{ label: libraryName, path: "" }];
  const segments = path.split("/").filter(Boolean);
  return crumbs.concat(segments.map((label, index) => ({ label, path: segments.slice(0, index + 1).join("/") })));
}

function readFileBrowserLocation(): { libraryId: string | null; path: string } {
  const params = new URLSearchParams(window.location.search);
  return { libraryId: params.get("libraryId"), path: normalizeLibraryPath(params.get("path")) };
}

function filesTaskReturnScope(currentPath: string, workspaceId: string, projectId: string) {
  const route = `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/files`;
  return {
    appBasePath: currentPath.endsWith(route) ? currentPath.slice(0, -route.length) : "",
    workspaceId,
    projectId
  };
}

function writeFileBrowserLocation(libraryId: string | null, path: string, replace: boolean) {
  const params = new URLSearchParams(window.location.search);
  params.delete("library");
  if (libraryId) params.set("libraryId", libraryId); else params.delete("libraryId");
  if (path) params.set("path", path); else params.delete("path");
  const url = `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`;
  if (replace) window.history.replaceState(window.history.state, "", url);
  else window.history.pushState(window.history.state, "", url);
}

function fileEntryVersionChanged(current: ProjectFile, refreshed: ProjectFile): boolean {
  return current.type !== refreshed.type ||
    current.size !== refreshed.size ||
    current.mediaType !== refreshed.mediaType ||
    current.updatedAt !== refreshed.updatedAt;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : fallback;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.message === "File not found";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDate(value: string): string {
  return formatLocalDateTime(value);
}
