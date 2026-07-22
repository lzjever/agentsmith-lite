"use client";

import { AlertCircle, Library, Plus, X } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogHeader, Selector } from "@astryxdesign/core";
import { ApiError, type Endpoint, type FileLibrary } from "../../lib/api/client";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export type TaskCreateValue = {
  title: string;
  prompt: string;
  endpointId: string;
  fileLibrary: { mode: "create_new"; name: string } | { mode: "use_existing"; id: string };
};

export function TaskCreateDialog({
  endpoints, libraries, librariesLoading, policyHref = "policy", open, saving, onClose, onCreate
}: {
  endpoints: Endpoint[];
  libraries: FileLibrary[];
  librariesLoading: boolean;
  policyHref?: string;
  open: boolean;
  saving: boolean;
  onClose: () => void;
  onCreate: (input: TaskCreateValue) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [libraryMode, setLibraryMode] = useState<"create_new" | "use_existing">("create_new");
  const [libraryName, setLibraryName] = useState("Task workspace");
  const [libraryNameEdited, setLibraryNameEdited] = useState(false);
  const [libraryId, setLibraryId] = useState("");
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const wasOpen = useRef(false);
  const availableLibraries = libraries.filter((library) => library.boundTask === null && library.capabilities.canWriteFiles);

  useEffect(() => {
    if (!open) { wasOpen.current = false; return; }
    if (wasOpen.current) return;
    wasOpen.current = true;
    setTitle("");
    setPrompt("");
    setLibraryMode("create_new");
    setLibraryName("Task workspace");
    setLibraryNameEdited(false);
    setLibraryId("");
    clearError();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setEndpointId((current) => endpoints.some((endpoint) => endpoint.id === current) ? current : (endpoints[0]?.id ?? ""));
  }, [endpoints, open]);

  useEffect(() => {
    if (!open) return;
    setLibraryId((current) => availableLibraries.some((library) => library.id === current) ? current : (availableLibraries[0]?.id ?? ""));
  }, [libraries, open]);

  function changeTitle(nextTitle: string) {
    setTitle(nextTitle);
    if (!libraryNameEdited) setLibraryName(generatedLibraryName(nextTitle));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fileLibrary = libraryMode === "create_new"
      ? { mode: "create_new" as const, name: libraryName.trim() }
      : { mode: "use_existing" as const, id: libraryId };
    if (!prompt.trim() || !endpointId || saving || (fileLibrary.mode === "create_new" ? !fileLibrary.name : !fileLibrary.id)) return;
    clearError();
    try {
      await onCreate({ title: title.trim(), prompt: prompt.trim(), endpointId, fileLibrary });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The task could not be created.");
      setErrorCode(reason instanceof ApiError ? reason.code ?? "" : "");
    }
  }

  const busy = saving;
  const validLibrary = libraryMode === "create_new" ? Boolean(libraryName.trim()) : Boolean(libraryId);
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !busy) onClose();
  };

  return <Dialog isOpen={open} onOpenChange={handleOpenChange} purpose="info" width="min(42rem, calc(100vw - 2rem))" maxHeight="calc(100dvh - 2rem)" padding={0} aria-label="Create task">
    <div className="overflow-y-auto">
      <form onSubmit={(event) => void submit(event)} aria-label="Create task">
        <DialogHeader title="Create task" subtitle="Describe the work for the Botified sandbox." hasDivider padding={5} endContent={<Button label="Close create task" variant="ghost" size="lg" isIconOnly icon={<X size={17} />} isDisabled={busy} onClick={() => handleOpenChange(false)} />} />
        {error ? <div className="mx-5 mt-4 flex items-start gap-2 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert"><AlertCircle className="mt-0.5 size-4 shrink-0" /><div>{errorCode === "active_tasks_limit_reached" ? <><p className="font-medium">Active task limit reached.</p><p className="mt-1 text-secondary">Wait for or cancel an active task. Project administrators can change the limit. <Link className="font-medium text-foreground hover:underline" href={policyHref}>Open resource policy</Link>.</p></> : error}</div></div> : null}
        <div className="grid gap-5 px-5 py-5">
          {endpoints.length === 0 ? <p className="border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">No task-ready endpoint is available. Add or repair an endpoint before creating a task.</p> : <>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm text-secondary">Title <span className="text-tertiary">(optional)</span><Input value={title} onChange={(event) => changeTitle(event.target.value)} maxLength={160} placeholder="Task title" autoFocus disabled={busy} /></label>
              <label className="grid gap-1.5 text-sm text-secondary">Endpoint<Selector label="Endpoint" isLabelHidden options={endpoints.map((endpoint) => ({ value: endpoint.id, label: `${endpoint.name} (${endpoint.model})` }))} value={endpointId} onChange={setEndpointId} isDisabled={busy} size="lg" /></label>
            </div>
            <fieldset className="grid gap-3"><legend className="text-sm text-secondary">File Library</legend>
              <label className={`flex cursor-pointer items-start gap-3 border px-3 py-3 ${libraryMode === "create_new" ? "border-foreground bg-surface-low" : "border-border"}`}><input type="radio" name="file-library-mode" value="create_new" checked={libraryMode === "create_new"} disabled={busy} onChange={() => setLibraryMode("create_new")} /><Plus className="mt-0.5 size-4 shrink-0 text-icon-default" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">Create new library</span><span className="mt-1 block text-xs text-secondary">Start this task with its own workspace.</span></span></label>
              {libraryMode === "create_new" ? <label className="ml-7 grid gap-1.5 text-sm text-secondary">Library name<Input value={libraryName} onChange={(event) => { setLibraryName(event.target.value); setLibraryNameEdited(true); }} maxLength={160} disabled={busy} /></label> : null}
              <label className={`flex cursor-pointer items-start gap-3 border px-3 py-3 ${libraryMode === "use_existing" ? "border-foreground bg-surface-low" : "border-border"}`}><input type="radio" name="file-library-mode" value="use_existing" checked={libraryMode === "use_existing"} disabled={busy || availableLibraries.length === 0} onChange={() => setLibraryMode("use_existing")} /><Library className="mt-0.5 size-4 shrink-0 text-icon-default" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">Use existing library</span><span className="mt-1 block text-xs text-secondary">Choose an available library you can bind to this task.</span></span></label>
              {libraryMode === "use_existing" ? librariesLoading ? <p className="ml-7 text-sm text-tertiary">Loading File Libraries...</p> : availableLibraries.length > 0 ? <label className="ml-7 grid gap-1.5 text-sm text-secondary">Library<Selector label="Existing File Library" isLabelHidden options={availableLibraries.map((library) => ({ value: library.id, label: library.name }))} value={libraryId} onChange={setLibraryId} isDisabled={busy} size="lg" /></label> : <p className="ml-7 text-sm text-tertiary">No unbound File Library is available.</p> : null}
            </fieldset>
            <label className="grid gap-1.5 text-sm text-secondary">Task prompt<Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} className="min-h-36 resize-y" placeholder="Describe the result you need" disabled={busy} /></label>
          </>}
        </div>
        <footer className="flex flex-col-reverse gap-2 border-t border-subtle px-5 py-4 sm:flex-row sm:justify-end md:px-6"><Button type="button" label="Cancel" variant="ghost" size="lg" onClick={onClose} isDisabled={busy} /><Button type="submit" label={saving ? "Creating..." : "Create task"} variant="primary" size="lg" isDisabled={!prompt.trim() || !endpointId || !validLibrary || busy} /></footer>
      </form>
    </div>
  </Dialog>;

  function clearError() { setError(""); setErrorCode(""); }
}

function generatedLibraryName(title: string): string {
  const trimmed = title.trim();
  return `${trimmed.slice(0, 150) || "Task"} workspace`;
}
