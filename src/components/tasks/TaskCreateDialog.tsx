"use client";

import { Library, Plus } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Banner, Button, Dialog, DialogHeader, RadioList, RadioListItem, Selector, Text, TextArea, TextInput } from "@astryxdesign/core";
import { type Endpoint, type FileLibrary } from "../../lib/api/client";
import { EndpointPicker } from "../providers/ProviderDirectoryPicker";
import { sandboxCapacityRecovery, type SandboxCapacityRecovery } from "./sandbox-capacity-recovery";
import { SandboxCapacityRecoveryNotice } from "./SandboxCapacityRecoveryNotice";
import {
  restoreTaskCreateDraft,
  TaskCommandStorageUnavailableError,
  writeTaskCreateDraft,
  type TaskCreateDraft
} from "./task-command-storage";
import {
  TASK_DRAFT_STORAGE_NOTICE,
  taskDraftStorage
} from "./task-draft-snapshot";

export type TaskCreateValue = {
  title: string;
  prompt: string;
  endpointId: string;
  fileLibrary: { mode: "create_new"; name: string } | { mode: "use_existing"; id: string };
};

export function TaskCreateDialog({
  userId, projectId, endpointPickerRevision, libraries, librariesLoading, activeSandboxesHref, canManagePolicy, policyHref = "policy", open, saving, payloadLocked, storageUnavailable, onClose, onCreate
}: {
  userId:string;
  projectId:string;
  endpointPickerRevision:number;
  libraries: FileLibrary[];
  librariesLoading: boolean;
  activeSandboxesHref: string;
  canManagePolicy: boolean;
  policyHref?: string;
  open: boolean;
  saving: boolean;
  payloadLocked: boolean;
  storageUnavailable: boolean;
  onClose: () => void;
  onCreate: (input: TaskCreateValue) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [selectedEndpoint,setSelectedEndpoint]=useState<Endpoint>();
  const [libraryMode, setLibraryMode] = useState<"create_new" | "use_existing">("create_new");
  const [libraryName, setLibraryName] = useState("Task File Library");
  const [libraryNameEdited, setLibraryNameEdited] = useState(false);
  const [libraryId, setLibraryId] = useState("");
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState<SandboxCapacityRecovery | null>(null);
  const [draftNotice, setDraftNotice] = useState("");
  const wasOpen = useRef(false);
  const previousEndpointPickerRevision = useRef(endpointPickerRevision);
  const availableLibraries = libraries.filter((library) => library.boundTask === null && library.capabilities.canWriteFiles);

  useEffect(() => {
    if (!open) { wasOpen.current = false; return; }
    if (wasOpen.current) return;
    wasOpen.current = true;
    const restored = restoreTaskCreateDraft(
      taskDraftStorage(),
      { userId, projectId }
    );
    const draft = restored ?? emptyTaskCreateDraft();
    setTitle(draft.title);
    setPrompt(draft.prompt);
    setLibraryMode(draft.fileLibrary.mode);
    setLibraryName(draft.fileLibrary.mode === "create_new"
      ? draft.fileLibrary.name
      : "Task File Library");
    setLibraryNameEdited(false);
    setLibraryId(draft.fileLibrary.mode === "use_existing"
      ? draft.fileLibrary.id
      : "");
    setEndpointId(draft.endpointId);
    setSelectedEndpoint(undefined);
    setDraftNotice(taskDraftStorage() ? "" : TASK_DRAFT_STORAGE_NOTICE);
    clearError();
  }, [open, projectId, userId]);

  useEffect(() => {
    if (!open || payloadLocked) return;
    setLibraryId((current) => availableLibraries.some((library) => library.id === current) ? current : (availableLibraries[0]?.id ?? ""));
  }, [libraries, open, payloadLocked]);

  useEffect(()=>{
    const changed = previousEndpointPickerRevision.current !== endpointPickerRevision;
    previousEndpointPickerRevision.current = endpointPickerRevision;
    if(!open||payloadLocked||!changed)return;
    setEndpointId("");
    setSelectedEndpoint(undefined);
    saveDraft({ endpointId:"" });
  },[endpointPickerRevision,open,payloadLocked]);

  function changeTitle(nextTitle: string) {
    setTitle(nextTitle);
    const nextLibraryName = libraryNameEdited
      ? libraryName
      : generatedLibraryName(nextTitle);
    if (!libraryNameEdited) setLibraryName(nextLibraryName);
    saveDraft({
      title: nextTitle,
      libraryName: nextLibraryName
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fileLibrary = libraryMode === "create_new"
      ? { mode: "create_new" as const, name: libraryName.trim() }
      : { mode: "use_existing" as const, id: libraryId };
    if (!prompt.trim() || !endpointId || saving || (fileLibrary.mode === "create_new" ? !fileLibrary.name : !fileLibrary.id)) return;
    clearError();
    try {
      const input = {
        title: title.trim(),
        prompt: prompt.trim(),
        endpointId,
        fileLibrary
      };
      saveTaskCreateDraft(input);
      await onCreate(input);
    } catch (reason) {
      if (reason instanceof TaskCommandStorageUnavailableError) {
        setDraftNotice(TASK_DRAFT_STORAGE_NOTICE);
        clearError();
        return;
      }
      setError(reason instanceof Error ? reason.message : "The task could not be created.");
      setRecovery(sandboxCapacityRecovery(reason));
    }
  }

  const busy = saving;
  const validLibrary = libraryMode === "create_new" ? Boolean(libraryName.trim()) : Boolean(libraryId);
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !busy) onClose();
  };

  return <Dialog
    className="[&_button]:min-h-11 [&_button]:min-w-11"
    isOpen={open}
    onOpenChange={handleOpenChange}
    purpose="form"
    padding={0}
    width="min(42rem, calc(100dvw - 1rem))"
    maxHeight="calc(100dvh - 1rem)"
    aria-label="Create task"
  >
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DialogHeader className="p-4 sm:p-5" title="Create task" subtitle="Describe the agent work for this Sandbox." hasDivider {...(!busy ? { onOpenChange: handleOpenChange } : {})} />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-5">
      <form id="task-create-form" onSubmit={(event) => void submit(event)} aria-label="Create task">
        <div className="grid gap-5">
          {recovery ? <SandboxCapacityRecoveryNotice recovery={recovery} activeSandboxesHref={activeSandboxesHref} canManagePolicy={canManagePolicy} policyHref={policyHref} /> : null}
          {error && !recovery ? <Banner status="error" title="Task could not be created" description={error} /> : null}
          {draftNotice || storageUnavailable ? <Text as="p" display="block" type="supporting" color="secondary" role="status">{TASK_DRAFT_STORAGE_NOTICE}</Text> : null}
          <>
            <div className="grid gap-4">
              <TextInput label="Task title" isOptional value={title} onChange={(value) => changeTitle(value.slice(0, 160))} placeholder="Task title" hasAutoFocus data-autofocus="" isDisabled={busy || payloadLocked} width="100%" />
              <EndpointPicker key={`${endpointPickerRevision}:${open?"open":"closed"}`} projectId={projectId} label="Task endpoint" mode="task_ready" value={endpointId} {...(selectedEndpoint?{selected:selectedEndpoint}:{})} disabled={busy || payloadLocked} onChange={(endpoint)=>{setSelectedEndpoint(endpoint);setEndpointId(endpoint.id);saveDraft({endpointId:endpoint.id})}} onUnavailable={()=>{setSelectedEndpoint(undefined);setEndpointId("");saveDraft({endpointId:""})}}/>
            </div>
            <div className="grid gap-3">
              <RadioList label="File Library" htmlName="file-library-mode" value={libraryMode} onChange={(value) => { const mode = value as typeof libraryMode; setLibraryMode(mode); saveDraft({ libraryMode:mode }); }} isDisabled={busy || payloadLocked}>
                <RadioListItem value="create_new" label="Create new library" description="Start this task with its own File Library." startContent={<Plus className="size-4 text-icon-secondary" />} />
                <RadioListItem value="use_existing" label="Use existing library" description="Choose an available File Library you can bind to this task." startContent={<Library className="size-4 text-icon-secondary" />} isDisabled={availableLibraries.length === 0} />
              </RadioList>
              {libraryMode === "create_new" ? <div className="ml-7"><TextInput label="Library name" value={libraryName} onChange={(value) => { const name = value.slice(0, 160); setLibraryName(name); setLibraryNameEdited(true); saveDraft({libraryName:name}); }} isDisabled={busy || payloadLocked} width="100%" /></div> : null}
              {libraryMode === "use_existing" ? librariesLoading ? <Text className="ml-7" type="supporting" color="secondary">Loading File Libraries...</Text> : availableLibraries.length > 0 ? <div className="ml-7"><Selector label="Existing File Library" options={availableLibraries.map((library) => ({ value: library.id, label: library.name }))} value={libraryId} onChange={(id) => { setLibraryId(id); saveDraft({libraryId:id}); }} isDisabled={busy || payloadLocked} size="lg" /></div> : <Text className="ml-7" type="supporting" color="secondary">No unbound File Library is available.</Text> : null}
            </div>
            <TextArea label="Task prompt" value={prompt} onChange={(value) => { setPrompt(value); saveDraft({prompt:value}); }} rows={7} placeholder="Describe the result you need" isDisabled={busy || payloadLocked} width="100%" />
          </>
        </div>
      </form>
      </div>
      <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:p-5 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
        <Button label="Cancel" type="button" variant="ghost" size="lg" isDisabled={busy} onClick={onClose} />
        <Button type="submit" form="task-create-form" label={saving ? "Creating..." : "Create task"} variant="primary" size="lg" isLoading={saving} isDisabled={!prompt.trim() || !endpointId || !validLibrary || busy} />
      </div>
    </div>
  </Dialog>;

  function clearError() { setError(""); setRecovery(null); }

  function saveDraft(changes: {
    title?: string;
    prompt?: string;
    endpointId?: string;
    libraryMode?: "create_new" | "use_existing";
    libraryName?: string;
    libraryId?: string;
  }) {
    const mode = changes.libraryMode ?? libraryMode;
    saveTaskCreateDraft({
      title: changes.title ?? title,
      prompt: changes.prompt ?? prompt,
      endpointId: changes.endpointId ?? endpointId,
      fileLibrary: mode === "create_new"
        ? {
            mode,
            name: changes.libraryName ?? libraryName
          }
        : {
            mode,
            id: changes.libraryId ?? libraryId
          }
    });
  }

  function saveTaskCreateDraft(draft: TaskCreateDraft) {
    const outcome = writeTaskCreateDraft(
      taskDraftStorage(),
      { userId, projectId },
      draft
    );
    setDraftNotice(outcome === "saved" ? "" : TASK_DRAFT_STORAGE_NOTICE);
  }
}

function emptyTaskCreateDraft(): TaskCreateDraft {
  return {
    title: "",
    prompt: "",
    endpointId: "",
    fileLibrary: { mode: "create_new", name: "Task File Library" }
  };
}

function generatedLibraryName(title: string): string {
  const trimmed = title.trim();
  return `${trimmed.slice(0, 147) || "Task"} File Library`;
}
