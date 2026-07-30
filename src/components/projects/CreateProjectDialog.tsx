"use client";

import { FolderPlus } from "lucide-react";
import { Button, Dialog, DialogHeader, TextInput, useToast } from "@astryxdesign/core";
import { type FormEvent, useEffect, useId, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, notifyDirectoryChanged, type Project } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";

export function CreateProjectDialog({ workspaceId, open, onOpenChange, onCreated, onAccessChanged }: { workspaceId: string; open: boolean; onOpenChange: (open: boolean) => void; onCreated: (project: Project) => void; onAccessChanged?: (message: string) => void | Promise<void> }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
  const formId = useId();
  useEffect(() => { if (open) { setName(""); setError(""); mutationKeys.clear("project.create"); } }, [open]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (saving || !nextName) return;
    const requestIdentity = `${workspaceId}:${nextName}`;
    setSaving(true);
    setError("");
    try {
      const project = await apiClient.createProject(workspaceId, { name: nextName }, mutationKeys.key("project.create", requestIdentity));
      mutationKeys.complete("project.create", requestIdentity);
      onCreated(project);
      notifyDirectoryChanged();
      showToast({ body: "Project created" });
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("project.create", requestIdentity);
      const message = reason instanceof ApiError ? reason.message : "Project could not be created.";
      if (isWorkspaceAccessChanged(reason)) {
        setError(message);
        await onAccessChanged?.(message);
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  }
  const handleOpenChange = (next: boolean) => {
    if (saving) return;
    if (!next) mutationKeys.clear("project.create");
    onOpenChange(next);
  };

  return (
    <Dialog className="[&_button]:min-h-11 [&_button]:min-w-11" isOpen={open} onOpenChange={handleOpenChange} purpose="form" padding={0} width="min(34rem, calc(100dvw - 1rem))" maxHeight="calc(100dvh - 1rem)" aria-label="New project">
      <DialogHeader className="p-4 sm:px-6" title="New project" subtitle="Create a project with its own endpoints, files, members, and tasks." startContent={<span className="grid size-10 shrink-0 place-items-center rounded-md bg-accent-muted text-accent-text"><FolderPlus size={20} /></span>} hasDivider {...(!saving ? { onOpenChange: handleOpenChange } : {})} />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"><form id={formId} onSubmit={submit}><TextInput label="Project name" value={name} onChange={(value) => setName(value.slice(0, 160))} isRequired hasAutoFocus data-autofocus="" isDisabled={saving} {...(error && { status: { type: "error", message: error } as const })} width="100%" /></form></div>
      <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
        <Button type="button" label="Cancel" variant="ghost" size="lg" isDisabled={saving} onClick={() => handleOpenChange(false)} />
        <Button type="submit" form={formId} label={saving ? "Creating..." : "Create project"} variant="primary" size="lg" isDisabled={saving || name.trim().length === 0} isLoading={saving} />
      </div>
    </Dialog>
  );
}

function isWorkspaceAccessChanged(reason: unknown) {
  return isReadOnlyMutationError(reason)
    || reason instanceof ApiError && reason.status === 404 && reason.message === "Workspace not found";
}
