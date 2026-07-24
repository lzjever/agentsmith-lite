"use client";

import { FolderPlus } from "lucide-react";
import { Button, DialogHeader, Layout, LayoutContent, TextInput, useToast } from "@astryxdesign/core";
import { type FormEvent, useEffect, useId, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type Project } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { Dialog, DialogFooter } from "../ui/Dialog";

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
    if (!nextName) return;
    const requestIdentity = `${workspaceId}:${nextName}`;
    setSaving(true);
    setError("");
    try {
      const project = await apiClient.createProject(workspaceId, { name: nextName }, mutationKeys.key("project.create", requestIdentity));
      mutationKeys.complete("project.create", requestIdentity);
      onCreated(project);
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
    <Dialog isOpen={open} onOpenChange={handleOpenChange} purpose="form" width="min(34rem, calc(100vw - 2rem))" maxHeight="calc(100dvh - 2rem)" aria-label="Create project">
      <Layout
        header={<DialogHeader title="New project" subtitle="Create a project with its own endpoints, files, members, and tasks." onOpenChange={handleOpenChange} hasDivider startContent={<span className="grid size-10 shrink-0 place-items-center rounded-md bg-accent-muted text-accent-text"><FolderPlus size={20} /></span>} />}
        content={<LayoutContent><form id={formId} onSubmit={submit}><TextInput label="Project name" value={name} onChange={(value) => setName(value.slice(0, 160))} isRequired hasAutoFocus isDisabled={saving} {...(error && { status: { type: "error", message: error } as const })} width="100%" /></form></LayoutContent>}
        footer={<DialogFooter hasDivider secondaryAction={<Button type="button" label="Cancel" variant="ghost" size="lg" isDisabled={saving} onClick={() => handleOpenChange(false)} />} primaryAction={<Button type="submit" form={formId} label={saving ? "Creating..." : "Create project"} variant="primary" size="lg" isDisabled={saving || name.trim().length === 0} isLoading={saving} />} />}
      />
    </Dialog>
  );
}

function isWorkspaceAccessChanged(reason: unknown) {
  return isReadOnlyMutationError(reason)
    || reason instanceof ApiError && reason.status === 404 && reason.message === "Workspace not found";
}
