"use client";

import { AlertCircle, Library, Plus, X } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogHeader, RadioList, RadioListItem, Selector, TextArea, TextInput } from "@astryxdesign/core";
import { ApiError, type Endpoint, type FileLibrary } from "../../lib/api/client";

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
  const [libraryName, setLibraryName] = useState("Task File Library");
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
    setLibraryName("Task File Library");
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

  return <Dialog isOpen={open} onOpenChange={handleOpenChange} purpose="form" width="min(42rem, calc(100vw - 2rem))" maxHeight="calc(100dvh - 2rem)" padding={0} aria-label="Create task">
    <div className="overflow-y-auto">
      <form onSubmit={(event) => void submit(event)} aria-label="Create task">
        <DialogHeader title="Create task" subtitle="Describe the work for the Botified sandbox." hasDivider endContent={<Button label="Close create task" variant="ghost" size="lg" isIconOnly icon={<X size={17} />} isDisabled={busy} onClick={() => handleOpenChange(false)} />} />
        {error ? <div className="mx-5 mt-4 flex items-start gap-2 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert"><AlertCircle className="mt-0.5 size-4 shrink-0" /><div>{errorCode === "active_tasks_limit_reached" ? <><p className="font-medium">Active task limit reached.</p><p className="mt-1 text-secondary">Wait for or cancel an active task. Project administrators can change the limit. <Link className="font-medium text-foreground hover:underline" href={policyHref}>Open resource policy</Link>.</p></> : error}</div></div> : null}
        <div className="grid gap-5 px-5 py-5">
          {endpoints.length === 0 ? <p className="border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">No task-ready endpoint is available. Add or repair an endpoint before creating a task.</p> : <>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput label="Title" isOptional value={title} onChange={(value) => changeTitle(value.slice(0, 160))} placeholder="Task title" hasAutoFocus isDisabled={busy} width="100%" />
              <label className="grid gap-1.5 text-sm text-secondary">Endpoint<Selector label="Endpoint" isLabelHidden options={endpoints.map((endpoint) => ({ value: endpoint.id, label: `${endpoint.name} (${endpoint.model})` }))} value={endpointId} onChange={setEndpointId} isDisabled={busy} size="lg" /></label>
            </div>
            <div className="grid gap-3">
              <RadioList label="File Library" htmlName="file-library-mode" value={libraryMode} onChange={(value) => setLibraryMode(value as typeof libraryMode)} isDisabled={busy}>
                <RadioListItem value="create_new" label="Create new library" description="Start this task with its own File Library." startContent={<Plus className="size-4 text-icon-default" />} />
                <RadioListItem value="use_existing" label="Use existing library" description="Choose an available File Library you can bind to this task." startContent={<Library className="size-4 text-icon-default" />} isDisabled={availableLibraries.length === 0} />
              </RadioList>
              {libraryMode === "create_new" ? <div className="ml-7"><TextInput label="Library name" value={libraryName} onChange={(value) => { setLibraryName(value.slice(0, 160)); setLibraryNameEdited(true); }} isDisabled={busy} width="100%" /></div> : null}
              {libraryMode === "use_existing" ? librariesLoading ? <p className="ml-7 text-sm text-tertiary">Loading File Libraries...</p> : availableLibraries.length > 0 ? <label className="ml-7 grid gap-1.5 text-sm text-secondary">Library<Selector label="Existing File Library" isLabelHidden options={availableLibraries.map((library) => ({ value: library.id, label: library.name }))} value={libraryId} onChange={setLibraryId} isDisabled={busy} size="lg" /></label> : <p className="ml-7 text-sm text-tertiary">No unbound File Library is available.</p> : null}
            </div>
            <TextArea label="Task prompt" value={prompt} onChange={setPrompt} rows={7} placeholder="Describe the result you need" isDisabled={busy} width="100%" />
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
  return `${trimmed.slice(0, 147) || "Task"} File Library`;
}
