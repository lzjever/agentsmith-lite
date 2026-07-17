"use client";

import { FolderPlus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, apiClient, type Project } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";

export function CreateProjectDialog({ workspaceId, open, onOpenChange, onCreated }: { workspaceId: string; open: boolean; onOpenChange: (open: boolean) => void; onCreated: (project: Project) => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mutationKeys = useMutationKeys();
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
      toast.success("Project created");
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("project.create", requestIdentity);
      setError(reason instanceof ApiError ? reason.message : "Project could not be created.");
    } finally {
      setSaving(false);
    }
  }
  return <Dialog open={open} onOpenChange={(next) => { if (!saving) { if (!next) mutationKeys.clear("project.create"); onOpenChange(next); } }}><DialogContent className="left-auto right-0 top-0 h-full w-full max-w-xl -translate-x-0 -translate-y-0 rounded-none border-y-0 border-r-0"><form className="flex h-full flex-col" onSubmit={submit}><DialogHeader><div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-md bg-accent/10 text-accent"><FolderPlus size={20} /></span><div><p className="type-caption text-tertiary">Project</p><DialogTitle className="type-title mt-1 block">New project</DialogTitle><DialogDescription className="mt-1 text-sm text-secondary">Create a project with its own endpoints, files, members, and tasks.</DialogDescription></div></div></DialogHeader><div className="flex-1 px-6 py-5"><label className="grid gap-2 text-sm text-primary">Project name<Input autoFocus required value={name} onChange={(event) => setName(event.target.value)} disabled={saving} /></label>{error ? <p className="mt-3 text-sm text-error" role="alert">{error}</p> : null}</div><footer className="flex justify-end gap-2 border-t border-subtle px-6 py-4"><DialogClose asChild><Button variant="quiet" disabled={saving}>Cancel</Button></DialogClose><Button type="submit" disabled={saving || name.trim().length === 0}>{saving ? "Creating..." : "Create project"}</Button></footer></form></DialogContent></Dialog>;
}
