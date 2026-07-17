"use client";

import { AlertCircle, ChevronRight, FileText, Folder, FolderUp, Link as LinkIcon, Upload, X } from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, type Endpoint, type ProjectFile } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { fileBreadcrumbs, parentFilePath, PROJECT_FILES_ROOT, sortFileEntries } from "../files/fileBrowserState";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

interface TaskCreateValue { title: string; prompt: string; endpointId: string; inputPaths: string[]; }

export function TaskCreateDialog({
  endpoints, projectFiles, projectFilesLoading, projectId, canWriteFiles = false,
  open, saving, onClose, onCreate
}: {
  endpoints: Endpoint[];
  projectFiles: ProjectFile[];
  projectFilesLoading: boolean;
  projectId?: string;
  canWriteFiles?: boolean;
  open: boolean;
  saving: boolean;
  onClose: () => void;
  onCreate: (input: TaskCreateValue) => Promise<void>;
}) {
  const mutationKeys = useMutationKeys();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [inputPaths, setInputPaths] = useState<string[]>([]);
  const [browserPath, setBrowserPath] = useState(PROJECT_FILES_ROOT);
  const [browserEntries, setBrowserEntries] = useState<ProjectFile[]>(projectFiles);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [addingUrl, setAddingUrl] = useState(false);
  const [error, setError] = useState("");
  const uploadInput = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);
  const browserPathRef = useRef(PROJECT_FILES_ROOT);
  const browserLoadVersion = useRef(0);

  useEffect(() => {
    if (!open) {
      mutationKeys.clear("task-input.upload");
      mutationKeys.clear("task-input.url");
      wasOpen.current = false;
      browserLoadVersion.current += 1;
      setBrowserLoading(false);
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    setTitle("");
    setPrompt("");
    setInputPaths([]);
    browserPathRef.current = PROJECT_FILES_ROOT;
    browserLoadVersion.current += 1;
    setBrowserLoading(false);
    setBrowserPath(PROJECT_FILES_ROOT);
    setBrowserEntries(sortFileEntries(projectFiles));
    setUrlInput("");
    setError("");
  }, [endpoints, open, projectFiles]);

  useEffect(() => {
    if (!open) return;
    setEndpointId((current) => endpoints.some((endpoint) => endpoint.id === current) ? current : (endpoints[0]?.id ?? ""));
  }, [endpoints, open]);

  useEffect(() => {
    if (open && browserPathRef.current === PROJECT_FILES_ROOT) setBrowserEntries(sortFileEntries(projectFiles));
  }, [browserPath, open, projectFiles]);

  async function navigate(path: string) {
    if (!projectId) return;
    browserPathRef.current = path;
    const version = ++browserLoadVersion.current;
    setBrowserPath(path);
    setBrowserLoading(true);
    setError("");
    try {
      const loaded = await apiClient.files(projectId, path);
      if (version !== browserLoadVersion.current || browserPathRef.current !== path) return;
      setBrowserEntries(sortFileEntries(loaded.entries));
    } catch (reason) {
      if (version === browserLoadVersion.current && browserPathRef.current === path) setError(errorMessage(reason, "Project files could not be loaded."));
    } finally {
      if (version === browserLoadVersion.current && browserPathRef.current === path) setBrowserLoading(false);
    }
  }

  async function upload(file: File) {
    if (!projectId) return;
    const uploadPath = browserPathRef.current;
    setUploading(true);
    setError("");
    const filePath = `${uploadPath}/${file.name}`;
    const requestIdentity = `${filePath}:${file.size}:${file.lastModified}`;
    try {
      const written = await apiClient.uploadFile(projectId, filePath, file, { idempotencyKey: mutationKeys.key("task-input.upload", requestIdentity) });
      mutationKeys.complete("task-input.upload", requestIdentity);
      setInputPaths((current) => current.includes(written.path) ? current : [...current, written.path]);
      if (browserPathRef.current === uploadPath) await navigate(uploadPath);
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("task-input.upload", requestIdentity);
      setError(errorMessage(reason, "The file could not be uploaded."));
    } finally { setUploading(false); }
  }

  function selectUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void upload(file);
  }

  async function addUrl() {
    if (!projectId || !urlInput.trim()) return;
    const url = urlInput.trim();
    setAddingUrl(true);
    setError("");
    try {
      const written = await apiClient.createTaskUrlInput(projectId, url, mutationKeys.key("task-input.url", url));
      mutationKeys.complete("task-input.url", url);
      setInputPaths((current) => current.includes(written.path) ? current : [...current, written.path]);
      setUrlInput("");
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("task-input.url", url);
      setError(errorMessage(reason, "The URL could not be attached."));
    } finally { setAddingUrl(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim() || !endpointId || saving) return;
    setError("");
    try {
      await onCreate({ title: title.trim(), prompt: prompt.trim(), endpointId, inputPaths });
    } catch (reason) {
      setError(errorMessage(reason, "The task could not be created."));
    }
  }

  const parent = parentFilePath(browserPath);
  const crumbs = fileBreadcrumbs(browserPath);
  const entries = projectId ? browserEntries : projectFiles;
  const loadingFiles = projectFilesLoading || browserLoading;
  const busy = saving || uploading || addingUrl;

  return <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !busy && onClose()}>
    <DialogContent className="max-h-[calc(100vh-2rem)] max-w-3xl overflow-y-auto">
      <form onSubmit={(event) => void submit(event)} aria-label="Create task">
        <DialogHeader><div className="flex items-start justify-between gap-4"><div><DialogTitle className="type-title text-foreground">Create task</DialogTitle><DialogDescription className="mt-1 text-sm text-secondary">Describe the work for the Botified sandbox.</DialogDescription></div><DialogClose asChild><Button variant="quiet" size="icon" aria-label="Close create task" disabled={busy}><X size={17} /></Button></DialogClose></div></DialogHeader>
        {error ? <div className="mx-5 mt-4 flex items-start gap-2 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div> : null}
        <div className="grid gap-4 px-5 py-5">
          {endpoints.length === 0 ? <p className="border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">No task-ready endpoint is available. Add or repair an endpoint before creating a task.</p> : <>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm text-secondary">Title <span className="text-tertiary">(optional)</span><Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} placeholder="Task title" autoFocus disabled={busy} /></label>
              <label className="grid gap-1.5 text-sm text-secondary">Endpoint<Select value={endpointId} onValueChange={setEndpointId} disabled={busy}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{endpoints.map((endpoint) => <SelectItem key={endpoint.id} value={endpoint.id}>{endpoint.name} ({endpoint.model})</SelectItem>)}</SelectContent></Select></label>
            </div>
            <fieldset className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2"><legend className="text-sm text-secondary">Project inputs <span className="text-tertiary">({inputPaths.length} selected)</span></legend>{projectId && canWriteFiles ? <><Button type="button" variant="quiet" size="sm" disabled={busy} onClick={() => uploadInput.current?.click()}><Upload size={15} />{uploading ? "Uploading..." : "Upload and attach"}</Button><input ref={uploadInput} className="sr-only" type="file" onChange={selectUpload} /></> : null}</div>
              {projectId ? <nav className="flex min-h-9 items-center gap-1 overflow-x-auto border border-subtle px-2" aria-label="Task input path"><ol className="flex min-w-max items-center gap-1 text-xs text-secondary">{crumbs.map((crumb, index) => <li className="flex items-center gap-1" key={crumb.path}>{index ? <ChevronRight size={13} className="text-tertiary" /> : null}<button type="button" className="px-1 py-1 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={() => void navigate(crumb.path)}>{crumb.label}</button></li>)}</ol></nav> : null}
              {loadingFiles ? <p className="text-sm text-tertiary">Loading project files...</p> : entries.length || parent ? <div className="max-h-48 divide-y divide-subtle overflow-y-auto border border-subtle">{parent ? <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-secondary hover:bg-surface-low disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={() => void navigate(parent)}><FolderUp className="size-4" />Up one folder</button> : null}{entries.map((file) => <FileChoice key={file.path} file={file} selected={inputPaths.includes(file.path)} disabled={busy} onToggle={() => setInputPaths((current) => current.includes(file.path) ? current.filter((path) => path !== file.path) : [...current, file.path])} onOpen={() => void navigate(file.path)} />)}</div> : <p className="text-sm text-tertiary">No project files available.</p>}
              {projectId && canWriteFiles ? <div className="flex gap-2"><label className="relative min-w-0 flex-1"><span className="sr-only">Attach URL</span><LinkIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary" /><Input className="pl-9" type="url" value={urlInput} onChange={(event) => setUrlInput(event.target.value)} placeholder="https://example.com/resource" disabled={busy} /></label><Button type="button" variant="outline" disabled={!urlInput.trim() || busy} onClick={() => void addUrl()}>{addingUrl ? "Adding..." : "Add URL"}</Button></div> : null}
              {inputPaths.length ? <div className="flex flex-wrap gap-1.5">{inputPaths.map((path) => <button type="button" key={path} className="inline-flex max-w-full items-center gap-1 border border-border bg-surface-low px-2 py-1 text-xs text-secondary disabled:cursor-not-allowed disabled:opacity-50" title={`Remove ${path}`} disabled={busy} onClick={() => setInputPaths((current) => current.filter((candidate) => candidate !== path))}><span className="truncate">{path.replace(/^files\//, "")}</span><X size={12} /></button>)}</div> : null}
            </fieldset>
            <label className="grid gap-1.5 text-sm text-secondary">Task prompt<Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} className="min-h-36 resize-y" placeholder="Describe the result you need" disabled={busy} /></label>
          </>}
        </div>
        <DialogFooter><Button type="button" variant="quiet" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={!prompt.trim() || !endpointId || busy}>{saving ? "Creating..." : "Create task"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function FileChoice({ file, selected, disabled, onToggle, onOpen }: { file: ProjectFile; selected: boolean; disabled: boolean; onToggle: () => void; onOpen: () => void }) {
  const directory = file.type === "directory";
  return <div className="flex items-center gap-2 px-3 py-2 text-sm text-foreground"><Checkbox aria-label={`Attach ${file.name}`} checked={selected} disabled={disabled} onChange={onToggle} />{directory ? <Folder className="size-4 text-icon-default" /> : <FileText className="size-4 text-icon-default" />}<button type="button" className="min-w-0 flex-1 truncate text-left hover:underline disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={directory ? onOpen : onToggle}>{file.name}</button>{directory ? <button type="button" className="text-xs text-tertiary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50" disabled={disabled} onClick={onOpen}>Open</button> : null}</div>;
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}
