"use client";

import { ChevronRight, Download, FileText, Folder, FolderUp, Image, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type ProjectCapabilities, type ProjectFile } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { ErrorState } from "../ui/error-state";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/toast";
import { childFilePath, fileBreadcrumbs, fileBrowserDisplay, parentFilePath, PROJECT_FILES_ROOT, showFileDetails, sortFileEntries } from "./fileBrowserState";

type BrowserState = "loading" | "ready" | "error";
const previewImageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const previewTextTypes = new Set(["text/plain", "text/csv", "text/markdown", "application/json"]);
const maxPreviewBytes = 512_000;
export type FilePreview = { kind:"text"|"image";value:string;name:string;path:string };

export function invalidateFilePreview(preview: FilePreview | null, path: string): FilePreview | null {
  return preview?.path === path ? null : preview;
}

export function ProjectFilesPage({ projectId }: { projectId: string }) {
  return <ProjectFiles key={projectId} projectId={projectId} />;
}

function ProjectFiles({ projectId }: { projectId: string }) {
  const mutationKeys = useMutationKeys();
  const mounted = useRef(true);
  const [path, setPath] = useState(PROJECT_FILES_ROOT);
  const [entries, setEntries] = useState<ProjectFile[]>([]);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [state, setState] = useState<BrowserState>("loading");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<ProjectFile>();
  const [deleteTarget, setDeleteTarget] = useState<ProjectFile>();
  const [uploading, setUploading] = useState(false);
  const [uploadFailure, setUploadFailure] = useState<{ file: File; path: string; message: string }>();
  const [replaceTarget, setReplaceTarget] = useState<{ file: File; path: string }>();
  const [deleting, setDeleting] = useState(false);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [query,setQuery]=useState(""); const [preview,setPreview]=useState<FilePreview|null>(null); const [dropReady,setDropReady]=useState(false);
  const input = useRef<HTMLInputElement>(null);
  const currentPath = useRef(path);
  const loadVersion = useRef(0);
  const previewVersion = useRef(0);

  const load = useCallback(async (): Promise<boolean> => {
    const requestedPath = path;
    if (currentPath.current !== requestedPath) return false;
    const version = ++loadVersion.current;
    previewVersion.current += 1;
    setState("loading");
    setMessage("");
    setCapabilities(undefined);
    try {
      const [filesResult, capabilitiesResult] = await Promise.allSettled([apiClient.files(projectId, requestedPath), apiClient.projectCapabilities(projectId)]);
      if (!mounted.current || version !== loadVersion.current || currentPath.current !== requestedPath) return false;
      if (filesResult.status === "rejected") throw filesResult.reason;
      setEntries(sortFileEntries(filesResult.value.entries));
      setSelected((current) => filesResult.value.entries.find((entry) => entry.path === current?.path));
      setPreview(null);
      if (capabilitiesResult.status === "fulfilled") setCapabilities(capabilitiesResult.value);
      else setMessage("File permissions could not be loaded. Files are read-only until refreshed.");
      setState("ready");
      return true;
    } catch (error) {
      if (!mounted.current || version !== loadVersion.current || currentPath.current !== requestedPath) return false;
      setMessage(errorMessage(error, "Files could not be loaded."));
      setState("error");
      return false;
    }
  }, [path, projectId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function navigate(nextPath: string) {
    previewVersion.current += 1;
    currentPath.current = nextPath;
    setSelected(undefined);
    setPreview(null);
    setMobileDetailsOpen(false);
    setPath(nextPath);
  }

  function select(entry: ProjectFile) {
    previewVersion.current += 1;
    setSelected(entry);
    setPreview((current) => current?.path === entry.path ? current : null);
    setMobileDetailsOpen(true);
  }

  function forgetFile(filePath: string) {
    previewVersion.current += 1;
    setDeleteTarget((current) => current?.path === filePath ? undefined : current);
    setSelected((current) => current?.path === filePath ? undefined : current);
    setPreview((current) => invalidateFilePreview(current, filePath));
    setMobileDetailsOpen(false);
    setEntries((current) => current.filter((entry) => entry.path !== filePath));
  }

  async function revokeWriteAccess(error: unknown) {
    if (!isReadOnlyMutationError(error)) return false;
    setUploadFailure(undefined);
    setReplaceTarget(undefined);
    setDeleteTarget(undefined);
    if (error.status === 403) {
      setEntries([]);
      setSelected(undefined);
      setPreview(null);
      setMobileDetailsOpen(false);
      if (await load()) setMessage("File write access changed. Files are now read-only.");
      return true;
    }
    setCapabilities((current) => current ? { ...current, canWriteFiles: false } : current);
    setMessage("File write access changed. Files are now read-only.");
    return true;
  }

  async function upload(file: File, overwrite = false, uploadPath = path) {
    if (uploading || deleting) return;
    setUploading(true);
    setUploadFailure(undefined);
    setMessage("");
    const filePath = childFilePath(uploadPath, file.name);
    const requestIdentity = `${filePath}:${overwrite}:${file.size}:${file.lastModified}`;
    try {
      const written = await apiClient.uploadFile(projectId, filePath, file, { overwrite, idempotencyKey: mutationKeys.key("file.upload", requestIdentity) });
      mutationKeys.complete("file.upload", requestIdentity);
      if (!mounted.current) return;
      const entry: ProjectFile = {
        name: written.path.slice(written.path.lastIndexOf("/") + 1),
        path: written.path,
        type: "file",
        size: written.bytes,
        mediaType: written.mediaType,
        updatedAt: written.updatedAt
      };
      if (currentPath.current === uploadPath) {
        setEntries((current) => sortFileEntries([...current.filter((item) => item.path !== written.path), entry]));
        setSelected((current) => current?.path === written.path ? entry : current);
      }
      if (overwrite) {
        previewVersion.current += 1;
        setPreview((current) => invalidateFilePreview(current, written.path));
      }
      if (overwrite) setReplaceTarget(undefined);
      toast.success(overwrite ? "File replaced" : "File uploaded");
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError) mutationKeys.complete("file.upload", requestIdentity);
      if (await revokeWriteAccess(error)) return;
      if (!overwrite && error instanceof ApiError && error.status === 409 && error.message === "Project file already exists") {
        setReplaceTarget({ file, path: uploadPath });
      } else if (overwrite) {
        throw new Error(errorMessage(error, "File could not be replaced."));
      } else {
        setUploadFailure({ file, path: uploadPath, message: errorMessage(error, "File could not be uploaded.") });
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
  useEffect(()=>()=>{if(preview?.kind==="image")URL.revokeObjectURL(preview.value);},[preview]);
  async function openPreview(entry:ProjectFile){if(entry.type!=="file")return;const version=++previewVersion.current;try{if(!isPreviewableProjectFile(entry)||(entry.size??0)>maxPreviewBytes)throw new Error();const blob=await apiClient.downloadProjectFile(projectId,entry.path);if(!mounted.current||version!==previewVersion.current)return;if(blob.size>maxPreviewBytes)throw new Error();const mediaType=blob.type||entry.mediaType||"";if(previewImageTypes.has(mediaType)){const value=URL.createObjectURL(blob);if(version!==previewVersion.current){URL.revokeObjectURL(value);return;}setPreview(current=>{if(current?.kind==="image")URL.revokeObjectURL(current.value);return {kind:"image",value,name:entry.name,path:entry.path};});return;}if(previewTextTypes.has(mediaType)||(!mediaType&&/\.(txt|md|markdown|json|csv|log)$/i.test(entry.name))){const value=(await blob.text()).slice(0,16_000);if(!mounted.current||version!==previewVersion.current)return;setPreview({kind:"text",value,name:entry.name,path:entry.path});return;}throw new Error();}catch(error){if(!mounted.current||version!==previewVersion.current)return;if(isMissingFile(error)){forgetFile(entry.path);toast.error("File no longer exists.");return;}toast.error("Preview is unavailable for this file.");}}

  async function removeSelectedFile() {
    if (!deleteTarget || uploading || deleting) return;
    setDeleting(true);
    setMessage("");
    const requestIdentity = deleteTarget.path;
    try {
      let alreadyMissing = false;
      await apiClient.deleteFile(projectId, deleteTarget.path, mutationKeys.key("file.delete", requestIdentity)).catch((error) => {
        if (!isMissingFile(error)) throw error;
        alreadyMissing = true;
      });
      mutationKeys.complete("file.delete", requestIdentity);
      if (!mounted.current) return;
      forgetFile(deleteTarget.path);
      toast.success(alreadyMissing ? "File no longer exists" : "File deleted");
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError) mutationKeys.complete("file.delete", requestIdentity);
      if (await revokeWriteAccess(error)) return;
      throw new Error(errorMessage(error, "File could not be deleted."));
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }

  const parent = parentFilePath(path);
  const crumbs = fileBreadcrumbs(path);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleEntries = entries.filter((entry) => entry.name.toLowerCase().includes(normalizedQuery));
  const display = fileBrowserDisplay(state, entries, path);
  const noMatches = display === "listing" && normalizedQuery.length > 0 && visibleEntries.length === 0;
  const canWrite = capabilities?.canWriteFiles === true;
  const mutationBusy = uploading || deleting;
  return <PageLayout contentWidth="full" header={<PageHeader title="Files" subtitle="Project files available to this project and its tasks." actions={<div className="flex items-center gap-2"><Button variant="quiet" size="icon" title="Refresh files" aria-label="Refresh files" onClick={() => void load()} disabled={state === "loading" || mutationBusy}><RefreshCw size={16} /></Button>{canWrite ? <><Button onClick={() => input.current?.click()} disabled={mutationBusy}>{uploading ? <RefreshCw className="animate-spin" size={16} /> : <Upload size={16} />}{uploading ? "Uploading" : "Upload"}</Button><input ref={input} hidden type="file" onChange={selectUpload} /></> : null}</div>} />}>
    <div className="grid min-h-[34rem] gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <section className={`min-w-0 overflow-hidden rounded-md border bg-surface transition-colors ${dropReady ? "border-accent ring-2 ring-accent/25" : "border-subtle"}`} aria-label="Project files" aria-busy={state === "loading"} onDragEnter={(event)=>{if(canWrite&&!mutationBusy){event.preventDefault();setDropReady(true);}}} onDragOver={(event)=>{if(canWrite&&!mutationBusy)event.preventDefault();}} onDragLeave={(event)=>{if(canWrite&&!event.currentTarget.contains(event.relatedTarget as Node))setDropReady(false);}} onDrop={(event)=>{if(!canWrite)return;event.preventDefault();setDropReady(false);if(mutationBusy)return;const file=event.dataTransfer.files?.[0];if(file)void upload(file);}}>
        <p className="sr-only" aria-live="polite">{dropReady ? "Drop a file to upload" : ""}</p>
        <nav className="flex min-h-12 items-center gap-1 overflow-x-auto border-b border-subtle px-3" aria-label="File path"><ol className="flex min-w-max items-center gap-1 text-sm text-secondary">{crumbs.map((crumb, index) => <li className="flex items-center gap-1" key={crumb.path}>{index > 0 ? <ChevronRight className="size-4 text-tertiary" aria-hidden="true" /> : null}<button type="button" className="rounded-sm px-1.5 py-1 hover:bg-surface-low hover:text-foreground" onClick={() => navigate(crumb.path)}>{crumb.label}</button></li>)}</ol></nav>
        <div className="flex gap-2 border-b border-subtle p-3"><Label className="relative flex-1"><span className="sr-only">Filter files</span><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary"/><Input value={query} onChange={event=>setQuery(event.target.value)} className="pl-9 pr-8" placeholder="Filter files"/>{query?<Button className="absolute right-1 top-0.5" size="icon" variant="quiet" aria-label="Clear file filter" onClick={()=>setQuery("")}><X size={14}/></Button>:null}</Label></div>
        {message ? <div className="mx-3 mt-3 flex items-start justify-between gap-3 rounded-sm border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert"><span>{message}</span><Button variant="quiet" size="icon" aria-label="Dismiss error" onClick={() => setMessage("")}><X size={15} /></Button></div> : null}
        {uploadFailure ? <div className="mx-3 mt-3 flex items-center justify-between gap-3 rounded-sm border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert"><span>{uploadFailure.message}</span><div className="flex shrink-0 gap-1"><Button variant="quiet" size="sm" onClick={() => void upload(uploadFailure.file, false, uploadFailure.path)} disabled={mutationBusy}>Retry upload</Button><Button variant="quiet" size="icon" title="Refresh files" aria-label="Refresh files" onClick={() => void load()} disabled={mutationBusy}><RefreshCw size={15} /></Button></div></div> : null}
        {display === "loading" ? <FileBrowserLoading /> : null}
        {display === "error" ? <FileBrowserError onRetry={load} /> : null}
        {display === "empty" ? <FileBrowserEmpty nested={path !== PROJECT_FILES_ROOT} /> : null}
        {noMatches ? <FileBrowserNoMatches query={query.trim()} onClear={() => setQuery("")} /> : null}
        {display === "listing" && !noMatches ? <FileBrowserList entries={visibleEntries} parent={parent} selectedPath={selected?.path} onNavigate={navigate} onSelect={select} /> : null}
      </section>
      <aside className="hidden rounded-md border border-subtle bg-surface p-4 lg:block"><FileDetails entry={selected} projectId={projectId} canWrite={canWrite} mutationBusy={mutationBusy} onDelete={setDeleteTarget} onPreview={openPreview} /></aside>
    </div>
    <div className="lg:hidden">{selected ? <Button variant="quiet" className="w-full justify-between" aria-expanded={mobileDetailsOpen} onClick={() => setMobileDetailsOpen((open) => !open)}><span>File details</span><ChevronRight className={mobileDetailsOpen ? "rotate-90 transition-transform" : "transition-transform"} size={16} /></Button> : null}{showFileDetails(selected, true, mobileDetailsOpen) ? <div className="mt-2 rounded-md border border-subtle bg-surface p-4"><FileDetails entry={selected} projectId={projectId} canWrite={canWrite} mutationBusy={mutationBusy} onDelete={setDeleteTarget} onPreview={openPreview} /></div> : null}</div>
    {preview?<div className="mt-4 rounded-md border border-subtle bg-surface p-4"><div className="mb-3 flex justify-between"><strong>{preview.name}</strong><Button variant="quiet" size="icon" aria-label="Close preview" onClick={()=>{previewVersion.current+=1;if(preview.kind==="image")URL.revokeObjectURL(preview.value);setPreview(null);}}><X size={15}/></Button></div>{preview.kind==="image"?<img className="max-h-96 max-w-full" src={preview.value} alt={preview.name}/>:<pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">{preview.value}</pre>}</div>:null}
    <DeleteFileDialog entry={deleteTarget} deleting={deleting} onCancel={() => { if (!deleting) setDeleteTarget(undefined); }} onConfirm={removeSelectedFile} />
    <ConfirmationDialog open={Boolean(replaceTarget)} onOpenChange={(open) => !open && !uploading && setReplaceTarget(undefined)} title={`Replace ${replaceTarget?.file.name ?? "file"}?`} description="A file with this name already exists in this folder. This will permanently replace its contents." confirmText="Replace file" variant="default" confirmDisabled={uploading} onConfirm={() => replaceTarget ? upload(replaceTarget.file, true, replaceTarget.path) : undefined} errorContext="File could not be replaced" />
  </PageLayout>;
}

function FileBrowserLoading() {
  return <div className="space-y-2 p-3" aria-label="Loading files"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>;
}

function FileBrowserError({ onRetry }: { onRetry: () => Promise<unknown> }) {
  return <ErrorState title="Files unavailable" message="The project file list could not be loaded." onRetry={() => void onRetry()} />;
}

function FileBrowserEmpty({ nested }: { nested: boolean }) {
  return <div className="grid min-h-64 place-items-center px-6 text-center"><div><FolderUp className="mx-auto size-7 text-tertiary" /><h2 className="mt-3 type-title">{nested ? "This folder is empty" : "No files yet"}</h2><p className="mt-2 text-sm text-secondary">{nested ? "Use the path trail to return to another folder." : "Upload files for this project. Tasks receive their own server-managed input snapshot."}</p></div></div>;
}

function FileBrowserNoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return <div className="grid min-h-64 place-items-center px-6 text-center"><div><Search className="mx-auto size-7 text-tertiary" /><h2 className="mt-3 type-title">No matching files</h2><p className="mt-2 text-sm text-secondary">No files in this folder match "{query}".</p><Button className="mt-3" variant="quiet" onClick={onClear}>Clear filter</Button></div></div>;
}

function FileBrowserList({ entries, parent, selectedPath, onNavigate, onSelect }: { entries: ProjectFile[]; parent: string | null; selectedPath: string | undefined; onNavigate: (path: string) => void; onSelect: (entry: ProjectFile) => void }) {
  return <div className="divide-y divide-subtle">{parent ? <button type="button" className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 text-left text-secondary hover:bg-surface-low hover:text-foreground" onClick={() => onNavigate(parent)}><FolderUp className="size-5" /><span>Up one folder</span><span className="text-xs text-tertiary">..</span></button> : null}{entries.map((entry) => <FileRow key={entry.path} entry={entry} selected={entry.path === selectedPath} onNavigate={onNavigate} onSelect={onSelect} />)}</div>;
}

function FileRow({ entry, selected, onNavigate, onSelect }: { entry: ProjectFile; selected: boolean; onNavigate: (path: string) => void; onSelect: (entry: ProjectFile) => void }) {
  const directory = entry.type === "directory";
  return <div className={`grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-3 ${selected ? "bg-surface-low" : "hover:bg-surface-low"}`}><span className="text-icon-default">{directory ? <Folder className="size-5" /> : <FileText className="size-5" />}</span><button type="button" className="min-w-0 truncate text-left text-sm text-foreground" onClick={() => directory ? onNavigate(entry.path) : onSelect(entry)}>{entry.name}</button><button type="button" className="rounded-sm px-2 py-1 text-xs text-tertiary hover:bg-surface hover:text-foreground" aria-label={`Show details for ${entry.name}`} onClick={() => onSelect(entry)}>{directory ? "Folder" : formatBytes(entry.size ?? 0)}</button></div>;
}

function FileDetails({ entry, projectId, canWrite, mutationBusy, onDelete, onPreview }: { entry: ProjectFile | undefined; projectId: string; canWrite: boolean; mutationBusy: boolean; onDelete: (entry: ProjectFile) => void; onPreview:(entry:ProjectFile)=>void }) {
  if (!entry) return <div className="grid min-h-48 place-items-center text-center text-sm text-secondary"><span>Select a file to view its details.</span></div>;
  const file = entry.type === "file";
  return <div className="space-y-4"><div><p className="type-caption text-tertiary">{file ? "File" : "Folder"}</p><h2 className="mt-2 break-words type-title">{entry.name}</h2><p className="mt-1 break-all text-sm text-secondary">{entry.path}</p></div><dl className="space-y-3 border-y border-subtle py-3 text-sm"><div className="flex justify-between gap-3"><dt className="text-secondary">Size</dt><dd className="text-foreground">{file ? formatBytes(entry.size ?? 0) : "-"}</dd></div>{file?<div className="flex justify-between gap-3"><dt className="text-secondary">Type</dt><dd className="break-all text-right text-foreground">{entry.mediaType??"application/octet-stream"}</dd></div>:null}<div className="flex justify-between gap-3"><dt className="text-secondary">Updated</dt><dd className="text-right text-foreground">{formatDate(entry.updatedAt)}</dd></div></dl>{file ? <div className="flex flex-wrap gap-2"><a className="inline-flex min-h-9 items-center justify-center gap-2 rounded-sm border border-border-input bg-surface px-3 text-sm text-primary hover:bg-hover hover:text-foreground" href={apiClient.fileDownloadUrl(projectId, entry.path)}><Download size={16} />Download</a>{isPreviewableProjectFile(entry)&&((entry.size??0)<=maxPreviewBytes)?<Button variant="outline" onClick={()=>onPreview(entry)}><Image size={16}/>Preview</Button>:null}{canWrite ? <Button variant="danger" disabled={mutationBusy} onClick={() => onDelete(entry)}><Trash2 size={16} />Delete</Button> : null}</div> : null}</div>;
}

function isPreviewableProjectFile(entry:ProjectFile):boolean{return previewImageTypes.has(entry.mediaType??"")||previewTextTypes.has(entry.mediaType??"")||(!entry.mediaType&&/\.(png|jpe?g|gif|webp|txt|md|markdown|json|csv|log)$/i.test(entry.name));}

export function DeleteFileDialog({ entry, deleting, onCancel, onConfirm }: { entry: ProjectFile | undefined; deleting: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  return <ConfirmationDialog open={entry !== undefined} onOpenChange={(open) => !open && onCancel()} title="Delete file?" description={entry ? <>This permanently removes <strong className="text-foreground">{entry.name}</strong> from the project.</> : ""} confirmText={deleting ? "Deleting" : "Delete"} confirmDisabled={deleting} onConfirm={onConfirm} errorContext="File could not be deleted" />;
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
