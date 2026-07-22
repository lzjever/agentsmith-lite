"use client";

import { ChevronRight, Download, FileText, Folder, FolderOpen, FolderUp, Image, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@astryxdesign/core";
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type FileLibrary, type ProjectFile } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { ErrorState } from "../ui/error-state";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toast } from "../ui/toast";
import { showFileDetails, sortFileEntries } from "./fileBrowserState";

type LoadState = "loading" | "ready" | "error";
const previewImageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const previewTextTypes = new Set(["text/plain", "text/csv", "text/markdown", "application/json"]);
const maxPreviewBytes = 512_000;
export type FilePreview = { kind: "text" | "image"; value: string; name: string; path: string };

export function invalidateFilePreview(preview: FilePreview | null, path: string): FilePreview | null {
  return preview?.path === path ? null : preview;
}

export function ProjectFilesPage({ workspaceId, projectId }: { workspaceId?: string; projectId: string }) {
  return <ProjectFiles key={`${workspaceId ?? "workspace"}:${projectId}`} workspaceId={workspaceId} projectId={projectId} />;
}

function ProjectFiles({ workspaceId, projectId }: { workspaceId: string | undefined; projectId: string }) {
  const projectBasePath = workspaceId ? `/workspaces/${workspaceId}/projects/${projectId}` : "..";
  const mutationKeys = useMutationKeys();
  const mounted = useRef(true);
  const librariesRef = useRef<FileLibrary[]>([]);
  const selectedLibraryRef = useRef<string | null>(null);
  const pathRef = useRef("");
  const libraryLoadVersion = useRef(0);
  const fileLoadVersion = useRef(0);
  const previewVersion = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  const [libraries, setLibraries] = useState<FileLibrary[]>([]);
  const [librariesState, setLibrariesState] = useState<LoadState>("loading");
  const [librariesMessage, setLibrariesMessage] = useState("");
  const [canCreateLibrary, setCanCreateLibrary] = useState(false);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<ProjectFile[]>([]);
  const [filesState, setFilesState] = useState<LoadState>("ready");
  const [filesMessage, setFilesMessage] = useState("");
  const [selected, setSelected] = useState<ProjectFile>();
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [dropReady, setDropReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingFile, setDeletingFile] = useState(false);
  const [uploadFailure, setUploadFailure] = useState<{ libraryId: string; file: File; path: string; message: string; code?: string }>();
  const [replaceTarget, setReplaceTarget] = useState<{ libraryId: string; file: File; path: string }>();
  const [deleteFileTarget, setDeleteFileTarget] = useState<ProjectFile>();
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<FileLibrary>();
  const [deleteLibraryTarget, setDeleteLibraryTarget] = useState<FileLibrary>();
  const [libraryName, setLibraryName] = useState("");
  const [libraryDialogError, setLibraryDialogError] = useState("");
  const [libraryMutationPending, setLibraryMutationPending] = useState(false);

  const resetFileSelection = useCallback(() => {
    previewVersion.current += 1;
    setSelected(undefined);
    setPreview((current) => {
      if (current?.kind === "image") URL.revokeObjectURL(current.value);
      return null;
    });
    setPreviewError("");
    setMobileDetailsOpen(false);
  }, []);

  const applyLocation = useCallback((libraryId: string | null, nextPath: string) => {
    fileLoadVersion.current += 1;
    selectedLibraryRef.current = libraryId;
    pathRef.current = nextPath;
    setSelectedLibraryId(libraryId);
    setPath(nextPath);
    setUploadFailure(undefined);
    setReplaceTarget(undefined);
    resetFileSelection();
  }, [resetFileSelection]);

  const loadLibraries = useCallback(async () => {
    const version = ++libraryLoadVersion.current;
    setLibrariesState("loading");
    setLibrariesMessage("");
    const [libraryResult, capabilityResult] = await Promise.allSettled([
      apiClient.fileLibraries(projectId),
      apiClient.projectCapabilities(projectId)
    ]);
    if (!mounted.current || version !== libraryLoadVersion.current) return;
    setCanCreateLibrary(capabilityResult.status === "fulfilled" && capabilityResult.value.canWriteFiles);
    if (libraryResult.status === "rejected") {
      setLibraries([]);
      librariesRef.current = [];
      setLibrariesMessage(errorMessage(libraryResult.reason, "File Libraries could not be loaded."));
      setLibrariesState("error");
      applyLocation(null, "");
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
    };
  }, [loadLibraries]);

  useEffect(() => {
    function restoreLocation() {
      const location = readFileBrowserLocation();
      const available = librariesRef.current;
      const nextId = available.some((library) => library.id === location.libraryId) ? location.libraryId : available[0]?.id ?? null;
      applyLocation(nextId, nextId === location.libraryId ? location.path : "");
    }
    window.addEventListener("popstate", restoreLocation);
    return () => window.removeEventListener("popstate", restoreLocation);
  }, [applyLocation]);

  const loadFiles = useCallback(async () => {
    if (!selectedLibraryId) {
      setEntries([]);
      setFilesState("ready");
      return;
    }
    const requestedLibraryId = selectedLibraryId;
    const requestedPath = path;
    const version = ++fileLoadVersion.current;
    setFilesState("loading");
    setFilesMessage("");
    setUploadFailure(undefined);
    try {
      const result = await apiClient.libraryFiles(projectId, requestedLibraryId, requestedPath);
      if (!mounted.current || version !== fileLoadVersion.current || selectedLibraryRef.current !== requestedLibraryId || pathRef.current !== requestedPath) return;
      setEntries(sortFileEntries(result.entries));
      setSelected((current) => result.entries.find((entry) => entry.path === current?.path));
      setFilesState("ready");
    } catch (error) {
      if (!mounted.current || version !== fileLoadVersion.current || selectedLibraryRef.current !== requestedLibraryId || pathRef.current !== requestedPath) return;
      if (error instanceof ApiError && error.status === 404 && error.message === "File Library not found") {
        await loadLibraries();
        return;
      }
      setEntries([]);
      resetFileSelection();
      setFilesMessage(errorMessage(error, "Files could not be loaded."));
      setFilesState("error");
    }
  }, [loadLibraries, path, projectId, resetFileSelection, selectedLibraryId]);

  useEffect(() => {
    if (librariesState === "ready") void loadFiles();
  }, [librariesState, loadFiles]);

  useEffect(() => () => {
    if (preview?.kind === "image") URL.revokeObjectURL(preview.value);
  }, [preview]);

  const selectedLibrary = libraries.find((library) => library.id === selectedLibraryId);
  const canWriteFiles = selectedLibrary?.capabilities.canWriteFiles === true;
  const mutationBusy = uploading || deletingFile || libraryMutationPending;

  function selectLibrary(libraryId: string) {
    if (libraryId === selectedLibraryRef.current) return;
    applyLocation(libraryId, "");
    setEntries([]);
    setQuery("");
    setFilesMessage("");
    writeFileBrowserLocation(libraryId, "", false);
  }

  function navigate(nextPath: string) {
    const normalized = normalizeLibraryPath(nextPath);
    pathRef.current = normalized;
    setPath(normalized);
    setEntries([]);
    resetFileSelection();
    writeFileBrowserLocation(selectedLibraryRef.current, normalized, false);
  }

  function selectFile(entry: ProjectFile) {
    previewVersion.current += 1;
    setSelected(entry);
    setPreview((current) => current?.path === entry.path ? current : null);
    setPreviewError("");
    setMobileDetailsOpen(true);
  }

  function forgetFile(filePath: string) {
    previewVersion.current += 1;
    setDeleteFileTarget((current) => current?.path === filePath ? undefined : current);
    setSelected((current) => current?.path === filePath ? undefined : current);
    setPreview((current) => invalidateFilePreview(current, filePath));
    setPreviewError("");
    setMobileDetailsOpen(false);
    setEntries((current) => current.filter((entry) => entry.path !== filePath));
  }

  async function revokeWriteAccess(error: unknown, libraryId: string) {
    if (!isReadOnlyMutationError(error)) return false;
    const next = librariesRef.current.map((library) => library.id === libraryId ? { ...library, capabilities: { ...library.capabilities, canRename: false, canDelete: false, canWriteFiles: false } } : library);
    librariesRef.current = next;
    setLibraries(next);
    if (selectedLibraryRef.current === libraryId) {
      setUploadFailure(undefined);
      setReplaceTarget(undefined);
      setDeleteFileTarget(undefined);
      setFilesMessage("File write access changed. This library is now read-only.");
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
    setFilesMessage("");
    const filePath = childLibraryPath(uploadPath, file.name);
    const requestIdentity = `${libraryId}:${filePath}:${overwrite}:${file.size}:${file.lastModified}`;
    try {
      const written = await apiClient.uploadLibraryFile(projectId, libraryId, filePath, file, { overwrite, idempotencyKey: mutationKeys.key("library-file.upload", requestIdentity) });
      mutationKeys.complete("library-file.upload", requestIdentity);
      if (!mounted.current) return;
      const entry: ProjectFile = { name: written.path.slice(written.path.lastIndexOf("/") + 1), path: written.path, type: "file", size: written.bytes, mediaType: written.mediaType, updatedAt: written.updatedAt };
      if (selectedLibraryRef.current === libraryId && pathRef.current === uploadPath) {
        setEntries((current) => sortFileEntries([...current.filter((item) => item.path !== written.path), entry]));
        setSelected((current) => current?.path === written.path ? entry : current);
      }
      if (overwrite) {
        previewVersion.current += 1;
        setPreview((current) => invalidateFilePreview(current, written.path));
        setReplaceTarget(undefined);
      }
      toast.success(overwrite ? "File replaced" : "File uploaded");
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError) mutationKeys.complete("library-file.upload", requestIdentity);
      if (await revokeWriteAccess(error, libraryId)) return;
      if (selectedLibraryRef.current !== libraryId) return;
      if (!overwrite && error instanceof ApiError && error.status === 409 && error.message === "Project file already exists") {
        setReplaceTarget({ libraryId, file, path: uploadPath });
      } else if (overwrite) {
        throw new Error(errorMessage(error, "File could not be replaced."));
      } else {
        setUploadFailure({ libraryId, file, path: uploadPath, message: errorMessage(error, "File could not be uploaded."), ...(error instanceof ApiError && error.code ? { code: error.code } : {}) });
      }
    } finally {
      if (mounted.current) setUploading(false);
    }
  }

  function selectUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void upload(file);
  }

  async function openPreview(entry: ProjectFile) {
    if (entry.type !== "file" || !selectedLibrary) return;
    const libraryId = selectedLibrary.id;
    const version = ++previewVersion.current;
    setPreview((current) => {
      if (current?.kind === "image") URL.revokeObjectURL(current.value);
      return null;
    });
    setPreviewError("");
    try {
      if (!isPreviewableProjectFile(entry) || (entry.size ?? 0) > maxPreviewBytes) throw new Error("This file type cannot be previewed safely.");
      const blob = await apiClient.previewLibraryFile(projectId, libraryId, entry.path);
      if (!mounted.current || version !== previewVersion.current || selectedLibraryRef.current !== libraryId) return;
      if (blob.size > maxPreviewBytes) throw new Error("This file is too large to preview.");
      const mediaType = blob.type || entry.mediaType || "";
      if (previewImageTypes.has(mediaType)) {
        const value = URL.createObjectURL(blob);
        if (version !== previewVersion.current) { URL.revokeObjectURL(value); return; }
        setPreview({ kind: "image", value, name: entry.name, path: entry.path });
        return;
      }
      if (previewTextTypes.has(mediaType) || (!mediaType && /\.(txt|md|markdown|json|csv|log)$/i.test(entry.name))) {
        const value = (await blob.text()).slice(0, 16_000);
        if (!mounted.current || version !== previewVersion.current) return;
        setPreview({ kind: "text", value, name: entry.name, path: entry.path });
        return;
      }
      throw new Error("This file type cannot be previewed safely.");
    } catch (error) {
      if (!mounted.current || version !== previewVersion.current) return;
      if (isMissingFile(error)) {
        forgetFile(entry.path);
        toast.error("File no longer exists.");
        return;
      }
      setPreviewError(errorMessage(error, "File preview could not be loaded."));
    }
  }

  async function removeFile() {
    if (!deleteFileTarget || !selectedLibrary || uploading || deletingFile) return;
    const target = deleteFileTarget;
    const libraryId = selectedLibrary.id;
    const requestIdentity = `${libraryId}:${target.path}`;
    setDeletingFile(true);
    try {
      let alreadyMissing = false;
      await apiClient.deleteLibraryFile(projectId, libraryId, target.path, mutationKeys.key("library-file.delete", requestIdentity)).catch((error) => {
        if (!isMissingFile(error)) throw error;
        alreadyMissing = true;
      });
      mutationKeys.complete("library-file.delete", requestIdentity);
      if (!mounted.current || selectedLibraryRef.current !== libraryId) return;
      forgetFile(target.path);
      toast.success(alreadyMissing ? "File no longer exists" : "File deleted");
    } catch (error) {
      if (error instanceof ApiError) mutationKeys.complete("library-file.delete", requestIdentity);
      if (await revokeWriteAccess(error, libraryId)) return;
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
      toast.success("File Library created");
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
      toast.success("File Library renamed");
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
      setEntries([]);
      writeFileBrowserLocation(fallback, "", true);
      toast.success("File Library deleted");
    } catch (error) {
      if (error instanceof ApiError) mutationKeys.complete("file-library.delete", requestIdentity);
      throw new Error(errorMessage(error, "File Library could not be deleted."));
    } finally {
      if (mounted.current) setLibraryMutationPending(false);
    }
  }

  const parent = parentLibraryPath(path);
  const crumbs = libraryBreadcrumbs(selectedLibrary?.name ?? "File Library", path);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleEntries = entries.filter((entry) => entry.name.toLowerCase().includes(normalizedQuery));
  const noMatches = filesState === "ready" && entries.length > 0 && normalizedQuery.length > 0 && visibleEntries.length === 0;

  return <PageLayout contentWidth="full" header={<PageHeader title="Files" subtitle="Browse and manage the File Libraries available in this project." actions={<div className="flex items-center gap-2"><Button variant="quiet" size="icon" title="Refresh File Libraries" aria-label="Refresh File Libraries" onClick={() => void loadLibraries()} disabled={librariesState === "loading" || mutationBusy}><RefreshCw size={16} /></Button>{canCreateLibrary ? <Button onClick={openCreateLibrary}><Plus size={16} />Create library</Button> : null}</div>} />}>
    <div className="grid min-h-[34rem] gap-4 lg:grid-cols-[16rem_minmax(0,1fr)_19rem]">
      <LibrariesPane state={librariesState} message={librariesMessage} libraries={libraries} selectedLibraryId={selectedLibraryId} projectBasePath={projectBasePath} canCreate={canCreateLibrary} mutationBusy={mutationBusy} onRetry={loadLibraries} onSelect={selectLibrary} onCreate={openCreateLibrary} onRename={openRenameLibrary} onDelete={setDeleteLibraryTarget} />
      <section className={`min-w-0 overflow-hidden rounded-md border bg-surface transition-colors ${dropReady ? "border-accent ring-2 ring-accent/25" : "border-subtle"}`} aria-label="Library files" aria-busy={filesState === "loading"} onDragEnter={(event) => { event.preventDefault(); if (canWriteFiles && !mutationBusy) setDropReady(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropReady(false); }} onDrop={(event) => { event.preventDefault(); setDropReady(false); if (!canWriteFiles || mutationBusy) return; const dropped = event.dataTransfer.files?.[0]; if (dropped) void upload(dropped); }}>
        {!selectedLibrary ? <NoLibrarySelected canCreate={canCreateLibrary} onCreate={openCreateLibrary} /> : <>
          <p className="sr-only" aria-live="polite">{dropReady ? "Drop a file to upload" : ""}</p>
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-subtle px-3">
            <nav className="min-w-0 overflow-x-auto" aria-label="Library path"><ol className="flex min-w-max items-center gap-1 text-sm text-secondary">{crumbs.map((crumb, index) => <li className="flex items-center gap-1" key={crumb.path}>{index > 0 ? <ChevronRight className="size-4 text-tertiary" aria-hidden="true" /> : null}<button type="button" className="max-w-56 truncate rounded-sm px-1.5 py-1 hover:bg-surface-low hover:text-foreground" title={crumb.label} onClick={() => navigate(crumb.path)}>{crumb.label}</button></li>)}</ol></nav>
            {canWriteFiles ? <><Button size="sm" onClick={() => input.current?.click()} disabled={mutationBusy}>{uploading ? <Loader2 className="animate-spin" size={15} /> : <Upload size={15} />}{uploading ? "Uploading" : "Upload"}</Button><input ref={input} hidden type="file" onChange={selectUpload} /></> : null}
          </div>
          <div className="flex gap-2 border-b border-subtle p-3"><Label className="relative flex-1"><span className="sr-only">Filter files</span><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9 pr-8" placeholder="Filter files" />{query ? <Button className="absolute right-1 top-0.5" size="icon" variant="quiet" aria-label="Clear file filter" onClick={() => setQuery("")}><X size={14} /></Button> : null}</Label></div>
          {filesMessage ? <InlineError message={filesMessage} onDismiss={() => setFilesMessage("")} /> : null}
          {uploadFailure ? <div className="mx-3 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert"><span>{uploadFailure.code === "project_file_bytes_limit_reached" ? <><strong>File storage limit reached.</strong> Delete files or ask a project administrator to change the limit. <Link className="font-medium text-foreground hover:underline" href={`${projectBasePath}/policy`}>Open resource policy</Link>.</> : uploadFailure.message}</span><div className="flex shrink-0 gap-1">{uploadFailure.code !== "project_file_bytes_limit_reached" ? <Button variant="quiet" size="sm" onClick={() => void upload(uploadFailure.file, false, uploadFailure.path, uploadFailure.libraryId)} disabled={mutationBusy}>Retry upload</Button> : null}<Button variant="quiet" size="icon" aria-label="Refresh files" onClick={() => void loadFiles()} disabled={mutationBusy}><RefreshCw size={15} /></Button></div></div> : null}
          {filesState === "loading" ? <FileBrowserLoading /> : null}
          {filesState === "error" ? <FileBrowserError onRetry={loadFiles} /> : null}
          {filesState === "ready" && entries.length === 0 ? <FileBrowserEmpty nested={path !== ""} canUpload={canWriteFiles} onUpload={() => input.current?.click()} /> : null}
          {noMatches ? <FileBrowserNoMatches query={query.trim()} onClear={() => setQuery("")} /> : null}
          {filesState === "ready" && entries.length > 0 && !noMatches ? <FileBrowserList entries={visibleEntries} parent={parent} selectedPath={selected?.path} onNavigate={navigate} onSelect={selectFile} /> : null}
        </>}
      </section>
      <aside className="hidden rounded-md border border-subtle bg-surface p-4 lg:block"><FileDetails entry={selected} projectId={projectId} library={selectedLibrary} mutationBusy={mutationBusy} onDelete={setDeleteFileTarget} onPreview={openPreview} /></aside>
    </div>
    <div className="lg:hidden">{selected ? <Button variant="quiet" className="w-full justify-between" aria-expanded={mobileDetailsOpen} onClick={() => setMobileDetailsOpen((open) => !open)}><span>File details</span><ChevronRight className={mobileDetailsOpen ? "rotate-90 transition-transform" : "transition-transform"} size={16} /></Button> : null}{showFileDetails(selected, true, mobileDetailsOpen) ? <div className="mt-2 rounded-md border border-subtle bg-surface p-4"><FileDetails entry={selected} projectId={projectId} library={selectedLibrary} mutationBusy={mutationBusy} onDelete={setDeleteFileTarget} onPreview={openPreview} /></div> : null}</div>
    {previewError && selected ? <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-error/30 bg-error/10 px-4 py-3" role="alert"><p className="text-sm text-error">{previewError}</p><div className="flex items-center gap-2"><Button variant="action" size="sm" onClick={() => void openPreview(selected)}><RefreshCw size={14} />Try preview again</Button><Button variant="quiet" size="icon" aria-label="Dismiss preview error" onClick={() => setPreviewError("")}><X size={15} /></Button></div></div> : null}
    {preview ? <div className="mt-4 rounded-md border border-subtle bg-surface p-4"><div className="mb-3 flex min-w-0 justify-between gap-3"><strong className="truncate" title={preview.name}>{preview.name}</strong><Button variant="quiet" size="icon" aria-label="Close preview" onClick={() => { previewVersion.current += 1; if (preview.kind === "image") URL.revokeObjectURL(preview.value); setPreview(null); }}><X size={15} /></Button></div>{preview.kind === "image" ? <img className="max-h-96 max-w-full" src={preview.value} alt={preview.name} /> : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{preview.value}</pre>}</div> : null}
    <LibraryNameDialog mode="create" open={createOpen} name={libraryName} error={libraryDialogError} pending={libraryMutationPending} onOpenChange={(open) => { if (!libraryMutationPending) { setCreateOpen(open); if (!open) setLibraryDialogError(""); } }} onNameChange={setLibraryName} onSubmit={createLibrary} />
    <LibraryNameDialog mode="rename" open={Boolean(renameTarget)} name={libraryName} error={libraryDialogError} pending={libraryMutationPending} onOpenChange={(open) => { if (!open && !libraryMutationPending) { setRenameTarget(undefined); setLibraryDialogError(""); } }} onNameChange={setLibraryName} onSubmit={renameLibrary} />
    <ConfirmationDialog open={Boolean(deleteLibraryTarget)} onOpenChange={(open) => !open && !libraryMutationPending && setDeleteLibraryTarget(undefined)} title="Delete File Library?" description={deleteLibraryTarget ? <>Delete <strong className="text-foreground">{deleteLibraryTarget.name}</strong>? The server will only delete an unbound, empty library.</> : ""} confirmText="Delete library" confirmDisabled={libraryMutationPending} onConfirm={deleteLibrary} errorContext="File Library could not be deleted" />
    <DeleteFileDialog entry={deleteFileTarget} deleting={deletingFile} onCancel={() => !deletingFile && setDeleteFileTarget(undefined)} onConfirm={removeFile} />
    <ConfirmationDialog open={Boolean(replaceTarget)} onOpenChange={(open) => !open && !uploading && setReplaceTarget(undefined)} title={`Replace ${replaceTarget?.file.name ?? "file"}?`} description="A file with this name already exists in this folder. This will permanently replace its contents." confirmText="Replace file" variant="default" confirmDisabled={uploading} onConfirm={() => replaceTarget ? upload(replaceTarget.file, true, replaceTarget.path, replaceTarget.libraryId) : undefined} errorContext="File could not be replaced" />
  </PageLayout>;
}

function LibrariesPane({ state, message, libraries, selectedLibraryId, projectBasePath, canCreate, mutationBusy, onRetry, onSelect, onCreate, onRename, onDelete }: { state: LoadState; message: string; libraries: FileLibrary[]; selectedLibraryId: string | null; projectBasePath: string; canCreate: boolean; mutationBusy: boolean; onRetry: () => Promise<void>; onSelect: (id: string) => void; onCreate: () => void; onRename: (library: FileLibrary) => void; onDelete: (library: FileLibrary) => void }) {
  return <section className="flex min-h-0 max-h-72 flex-col overflow-hidden rounded-md border border-subtle bg-surface lg:max-h-none" aria-label="File Libraries">
    <div className="flex min-h-12 items-center justify-between border-b border-subtle px-3"><div className="min-w-0"><h2 className="type-caption text-tertiary">File Libraries</h2><p className="mt-0.5 text-xs text-secondary">{libraries.length} {libraries.length === 1 ? "library" : "libraries"}</p></div>{canCreate ? <Button size="icon" variant="quiet" aria-label="Create library" title="Create library" onClick={onCreate} disabled={mutationBusy}><Plus size={16} /></Button> : null}</div>
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
      {state === "loading" ? <div className="space-y-2 p-1.5" aria-label="Loading File Libraries"><Skeleton height={48} /><Skeleton height={48} /></div> : null}
      {state === "error" ? <ErrorState title="Libraries unavailable" message={message} onRetry={() => void onRetry()} /> : null}
      {state === "ready" && libraries.length === 0 ? <p className="p-3 text-sm text-secondary">No File Libraries are available in this project.</p> : null}
      {state === "ready" ? libraries.map((library) => {
        const active = library.id === selectedLibraryId;
        const boundLabel = library.boundTask ? `Bound to ${library.boundTask.title || "Task"}` : null;
        return <div key={library.id} className={`group flex items-center gap-1 rounded-sm ${active ? "bg-accent/10 ring-1 ring-inset ring-accent/20" : "hover:bg-surface-low"}`}>
          <div className="min-w-0 flex-1 py-2"><button type="button" className="flex w-full min-w-0 items-center gap-2 px-2 text-left" aria-current={active ? "true" : undefined} aria-label={`Select library ${library.name}`} onClick={() => onSelect(library.id)} title={library.name}><FolderOpen className={`size-4 shrink-0 ${active ? "text-accent" : "text-tertiary"}`} /><span className="truncate text-sm text-foreground">{library.name}</span></button>{library.boundTask && boundLabel ? <Link className="mt-1 block truncate pl-8 pr-2 text-xs text-warning hover:underline" href={`${projectBasePath}/tasks/${encodeURIComponent(library.boundTask.id)}`} title={boundLabel}>{boundLabel}</Link> : <span className="mt-1 block pl-8 text-xs text-tertiary">Available</span>}</div>
          {active ? <div className="flex shrink-0 items-center pr-1"><Button size="icon" variant="quiet" className="h-7 w-7" aria-label={`Rename ${library.name}`} title={library.capabilities.canRename ? "Rename File Library" : "You do not have permission to rename this library"} disabled={!library.capabilities.canRename || mutationBusy} onClick={() => onRename(library)}><Pencil size={14} /></Button><Button size="icon" variant="quiet" className="h-7 w-7 text-error" aria-label={`Delete ${library.name}`} title={library.boundTask ? "This library is bound to a Task and cannot be deleted" : library.capabilities.canDelete ? "Delete File Library" : "You do not have permission to delete this library"} disabled={!library.capabilities.canDelete || mutationBusy} onClick={() => onDelete(library)}><Trash2 size={14} /></Button></div> : null}
        </div>;
      }) : null}
    </div>
  </section>;
}

function NoLibrarySelected({ canCreate, onCreate }: { canCreate: boolean; onCreate: () => void }) {
  return <div className="grid min-h-[28rem] place-items-center px-6 text-center"><div><FolderOpen className="mx-auto size-8 text-tertiary" /><h2 className="mt-3 type-title">No File Libraries</h2><p className="mt-2 max-w-sm text-sm text-secondary">Create a File Library to store and browse files for this project.</p>{canCreate ? <Button className="mt-4" onClick={onCreate}><Plus size={16} />Create library</Button> : null}</div></div>;
}

function LibraryNameDialog({ mode, open, name, error, pending, onOpenChange, onNameChange, onSubmit }: { mode: "create" | "rename"; open: boolean; name: string; error: string; pending: boolean; onOpenChange: (open: boolean) => void; onNameChange: (name: string) => void; onSubmit: (event: FormEvent) => void }) {
  const create = mode === "create";
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent aria-describedby={`${mode}-library-description`}><DialogHeader><div><DialogTitle>{create ? "Create File Library" : "Rename File Library"}</DialogTitle><DialogDescription id={`${mode}-library-description`} className="mt-1">{create ? "Libraries keep project files organized and can be assigned to Tasks." : "The library root and its files will not move."}</DialogDescription></div></DialogHeader>{error ? <div role="alert" className="mx-5 mt-4 rounded-sm border border-error/30 bg-error/10 px-3 py-2 text-sm text-error md:mx-6">{error}</div> : null}<form id={`${mode}-library-form`} className="px-5 py-5 md:px-6" onSubmit={onSubmit}><Label htmlFor={`${mode}-library-name`}>Library name</Label><Input id={`${mode}-library-name`} className="mt-2" value={name} onChange={(event) => onNameChange(event.target.value)} autoFocus maxLength={120} required /></form><DialogFooter><Button variant="quiet" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button><Button type="submit" form={`${mode}-library-form`} disabled={pending || !name.trim()}>{pending ? <Loader2 className="size-4 animate-spin" /> : null}{create ? "Create" : "Save"}</Button></DialogFooter></DialogContent></Dialog>;
}

function InlineError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return <div className="mx-3 mt-3 flex items-start justify-between gap-3 rounded-sm border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert"><span>{message}</span><Button variant="quiet" size="icon" aria-label="Dismiss error" onClick={onDismiss}><X size={15} /></Button></div>;
}

function FileBrowserLoading() {
  return <div className="space-y-2 p-3" aria-label="Loading files"><Skeleton height={40} /><Skeleton height={40} /><Skeleton height={40} /></div>;
}

function FileBrowserError({ onRetry }: { onRetry: () => Promise<unknown> }) {
  return <ErrorState title="Files unavailable" message="This library directory could not be loaded." onRetry={() => void onRetry()} />;
}

function FileBrowserEmpty({ nested, canUpload, onUpload }: { nested: boolean; canUpload: boolean; onUpload: () => void }) {
  return <div className="grid min-h-64 place-items-center px-6 text-center"><div><FolderUp className="mx-auto size-7 text-tertiary" /><h2 className="mt-3 type-title">{nested ? "This folder is empty" : "No files yet"}</h2><p className="mt-2 text-sm text-secondary">{nested ? "Use the path trail to return to another folder." : "Upload a file to this library."}</p>{canUpload ? <Button className="mt-4" variant="outline" onClick={onUpload}><Upload size={16} />Upload file</Button> : null}</div></div>;
}

function FileBrowserNoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return <div className="grid min-h-64 place-items-center px-6 text-center"><div><Search className="mx-auto size-7 text-tertiary" /><h2 className="mt-3 type-title">No matching files</h2><p className="mt-2 max-w-md break-words text-sm text-secondary">No files in this folder match "{query}".</p><Button className="mt-3" variant="quiet" onClick={onClear}>Clear filter</Button></div></div>;
}

function FileBrowserList({ entries, parent, selectedPath, onNavigate, onSelect }: { entries: ProjectFile[]; parent: string | null; selectedPath: string | undefined; onNavigate: (path: string) => void; onSelect: (entry: ProjectFile) => void }) {
  return <div className="divide-y divide-subtle">{parent !== null ? <button type="button" className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 text-left text-secondary hover:bg-surface-low hover:text-foreground" onClick={() => onNavigate(parent)}><FolderUp className="size-5" /><span>Up one folder</span><span className="text-xs text-tertiary">..</span></button> : null}{entries.map((entry) => <FileRow key={entry.path} entry={entry} selected={entry.path === selectedPath} onNavigate={onNavigate} onSelect={onSelect} />)}</div>;
}

function FileRow({ entry, selected, onNavigate, onSelect }: { entry: ProjectFile; selected: boolean; onNavigate: (path: string) => void; onSelect: (entry: ProjectFile) => void }) {
  const directory = entry.type === "directory";
  return <div className={`grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 ${selected ? "bg-surface-low" : "hover:bg-surface-low"}`}><span className="text-icon-default">{directory ? <Folder className="size-5" /> : <FileText className="size-5" />}</span><button type="button" className="min-w-0 truncate text-left text-sm text-foreground" title={entry.name} onClick={() => directory ? onNavigate(entry.path) : onSelect(entry)}>{entry.name}</button><button type="button" className="rounded-sm px-2 py-1 text-xs text-tertiary hover:bg-surface hover:text-foreground" aria-label={`Show details for ${entry.name}`} onClick={() => onSelect(entry)}>{directory ? "Folder" : formatBytes(entry.size ?? 0)}</button></div>;
}

function FileDetails({ entry, projectId, library, mutationBusy, onDelete, onPreview }: { entry: ProjectFile | undefined; projectId: string; library: FileLibrary | undefined; mutationBusy: boolean; onDelete: (entry: ProjectFile) => void; onPreview: (entry: ProjectFile) => void }) {
  if (!entry || !library) return <div className="grid min-h-48 place-items-center text-center text-sm text-secondary"><span>Select a file to view its details.</span></div>;
  const file = entry.type === "file";
  return <div className="space-y-4"><div><p className="type-caption text-tertiary">{file ? "File" : "Folder"}</p><h2 className="mt-2 break-words type-title">{entry.name}</h2><p className="mt-1 break-all text-sm text-secondary">{entry.path}</p></div><dl className="space-y-3 border-y border-subtle py-3 text-sm"><div className="flex justify-between gap-3"><dt className="text-secondary">Size</dt><dd className="text-foreground">{file ? formatBytes(entry.size ?? 0) : "-"}</dd></div>{file ? <div className="flex justify-between gap-3"><dt className="text-secondary">Type</dt><dd className="break-all text-right text-foreground">{entry.mediaType ?? "application/octet-stream"}</dd></div> : null}<div className="flex justify-between gap-3"><dt className="text-secondary">Updated</dt><dd className="text-right text-foreground">{formatDate(entry.updatedAt)}</dd></div></dl>{file ? <div className="flex flex-wrap gap-2"><a className="inline-flex min-h-9 items-center justify-center gap-2 rounded-sm border border-border-input bg-surface px-3 text-sm text-primary hover:bg-hover hover:text-foreground" href={apiClient.libraryFileDownloadUrl(projectId, library.id, entry.path)}><Download size={16} />Download</a>{isPreviewableProjectFile(entry) && (entry.size ?? 0) <= maxPreviewBytes ? <Button variant="outline" onClick={() => onPreview(entry)}><Image size={16} />Preview</Button> : null}{library.capabilities.canWriteFiles ? <Button variant="danger" disabled={mutationBusy} onClick={() => onDelete(entry)}><Trash2 size={16} />Delete</Button> : null}</div> : null}</div>;
}

export function DeleteFileDialog({ entry, deleting, onCancel, onConfirm }: { entry: ProjectFile | undefined; deleting: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  return <ConfirmationDialog open={entry !== undefined} onOpenChange={(open) => !open && onCancel()} title="Delete file?" description={entry ? <>This permanently removes <strong className="text-foreground">{entry.name}</strong> from this File Library.</> : ""} confirmText={deleting ? "Deleting" : "Delete"} confirmDisabled={deleting} onConfirm={onConfirm} errorContext="File could not be deleted" />;
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

function writeFileBrowserLocation(libraryId: string | null, path: string, replace: boolean) {
  const params = new URLSearchParams(window.location.search);
  params.delete("library");
  if (libraryId) params.set("libraryId", libraryId); else params.delete("libraryId");
  if (path) params.set("path", path); else params.delete("path");
  const url = `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`;
  if (replace) window.history.replaceState(window.history.state, "", url);
  else window.history.pushState(window.history.state, "", url);
}

function isPreviewableProjectFile(entry: ProjectFile): boolean {
  return previewImageTypes.has(entry.mediaType ?? "") || previewTextTypes.has(entry.mediaType ?? "") || (!entry.mediaType && /\.(png|jpe?g|gif|webp|txt|md|markdown|json|csv|log)$/i.test(entry.name));
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
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
