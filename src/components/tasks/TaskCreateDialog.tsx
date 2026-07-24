"use client";

import { Library, Plus } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Banner, Button, DialogHeader, Layout, LayoutContent, LayoutFooter, RadioList, RadioListItem, Selector, Text, TextArea, TextInput } from "@astryxdesign/core";
import { ApiError, type Endpoint, type FileLibrary } from "../../lib/api/client";
import { Dialog } from "../ui/Dialog";

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

  return <Dialog isOpen={open} onOpenChange={handleOpenChange} purpose="form" width="min(42rem, calc(100vw - 2rem))" maxHeight="calc(100dvh - 2rem)" aria-label="Create task">
    <Layout defaultHasDividers header={<DialogHeader title="Create task" subtitle="Describe the work for the Botified sandbox." onOpenChange={handleOpenChange} />} content={<LayoutContent>
      <form id="task-create-form" onSubmit={(event) => void submit(event)} aria-label="Create task">
        <div className="grid gap-5">
          {error ? <Banner status="error" title={errorCode === "active_tasks_limit_reached" ? "Active task limit reached" : "Task could not be created"} description={errorCode === "active_tasks_limit_reached" ? <>Wait for or cancel an active task. Project administrators can change the limit. <Link className="text-primary hover:underline" href={policyHref}><Text weight="medium">Open resource policy</Text></Link>.</> : error} /> : null}
          {endpoints.length === 0 ? <Banner status="warning" title="No task-ready endpoint" description="Add or repair an endpoint before creating a task." /> : <>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput label="Title" isOptional value={title} onChange={(value) => changeTitle(value.slice(0, 160))} placeholder="Task title" hasAutoFocus isDisabled={busy} width="100%" />
              <Selector label="Endpoint" options={endpoints.map((endpoint) => ({ value: endpoint.id, label: `${endpoint.name} (${endpoint.model})` }))} value={endpointId} onChange={setEndpointId} isDisabled={busy} size="lg" />
            </div>
            <div className="grid gap-3">
              <RadioList label="File Library" htmlName="file-library-mode" value={libraryMode} onChange={(value) => setLibraryMode(value as typeof libraryMode)} isDisabled={busy}>
                <RadioListItem value="create_new" label="Create new library" description="Start this task with its own File Library." startContent={<Plus className="size-4 text-icon-secondary" />} />
                <RadioListItem value="use_existing" label="Use existing library" description="Choose an available File Library you can bind to this task." startContent={<Library className="size-4 text-icon-secondary" />} isDisabled={availableLibraries.length === 0} />
              </RadioList>
              {libraryMode === "create_new" ? <div className="ml-7"><TextInput label="Library name" value={libraryName} onChange={(value) => { setLibraryName(value.slice(0, 160)); setLibraryNameEdited(true); }} isDisabled={busy} width="100%" /></div> : null}
              {libraryMode === "use_existing" ? librariesLoading ? <Text className="ml-7" type="supporting" color="secondary">Loading File Libraries...</Text> : availableLibraries.length > 0 ? <div className="ml-7"><Selector label="Existing File Library" options={availableLibraries.map((library) => ({ value: library.id, label: library.name }))} value={libraryId} onChange={setLibraryId} isDisabled={busy} size="lg" /></div> : <Text className="ml-7" type="supporting" color="secondary">No unbound File Library is available.</Text> : null}
            </div>
            <TextArea label="Task prompt" value={prompt} onChange={setPrompt} rows={7} placeholder="Describe the result you need" isDisabled={busy} width="100%" />
          </>}
        </div>
      </form>
    </LayoutContent>} footer={<LayoutFooter><div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" label="Cancel" variant="ghost" size="lg" onClick={onClose} isDisabled={busy} /><Button type="submit" form="task-create-form" label={saving ? "Creating..." : "Create task"} variant="primary" size="lg" isDisabled={!prompt.trim() || !endpointId || !validLibrary || busy} /></div></LayoutFooter>} />
  </Dialog>;

  function clearError() { setError(""); setErrorCode(""); }
}

function generatedLibraryName(title: string): string {
  const trimmed = title.trim();
  return `${trimmed.slice(0, 147) || "Task"} File Library`;
}
