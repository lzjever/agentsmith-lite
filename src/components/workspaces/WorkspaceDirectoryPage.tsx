"use client";

import { FolderKanban, Plus } from "lucide-react";
import Link from "next/link";
import { Badge, Button, Dialog, DialogHeader, EmptyState, Spinner } from "@astryxdesign/core";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, apiClient, type Workspace, type WorkspaceMemberRole } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { ErrorState } from "../ui/error-state";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";

type LoadState = "loading" | "ready" | "error";

export function WorkspaceDirectoryPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  async function load() {
    setState("loading");
    setError("");
    try {
      setWorkspaces(await apiClient.workspaces());
      setState("ready");
    } catch (reason) {
      setError(errorMessage(reason, "Workspaces could not be loaded."));
      setState("error");
    }
  }

  useEffect(() => { void load(); }, []);

  return <PageLayout header={<PageHeader title="Workspaces" subtitle="Choose a workspace to continue into its projects." actions={<Button label="New workspace" variant="primary" icon={<Plus size={16} />} isDisabled={state !== "ready"} onClick={() => setCreateOpen(true)} />} />}>
    {state === "loading" ? <PageState state="loading"><Spinner label="Loading workspaces..." /></PageState> : null}
    {state === "error" ? <WorkspaceError message={error} onRetry={load} /> : null}
    {state === "ready" && workspaces.length === 0 ? <WorkspaceEmpty onCreate={() => setCreateOpen(true)} /> : null}
    {state === "ready" && workspaces.length > 0 ? <WorkspaceList workspaces={workspaces} /> : null}
    <CreateWorkspaceDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(workspace) => { setWorkspaces((items) => [...items, workspace]); setCreateOpen(false); }} />
  </PageLayout>;
}

function WorkspaceList({ workspaces }: { workspaces: Workspace[] }) {
  return <div className="divide-y divide-subtle border-y border-subtle">{workspaces.map((workspace) => <Link key={workspace.id} href={`/workspaces/${workspace.id}`} className="group flex items-center justify-between gap-5 px-2 py-5 text-decoration-none transition-colors hover:bg-surface-low"><div className="flex min-w-0 items-center gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-sm bg-surface-high text-icon-default"><FolderKanban size={18} /></span><span className="min-w-0"><span className="flex min-w-0 items-center gap-2"><strong className="truncate font-medium text-foreground">{workspace.name}</strong><WorkspaceLifecycleBadge workspace={workspace} /></span><small className="mt-1 block text-secondary">{workspace.projects.length} {workspace.projects.length === 1 ? "project" : "projects"}</small><small className="mt-1 block truncate text-tertiary">Owner: {workspaceOwnerLabel(workspace)} · Your access: {roleLabel(workspace.memberRole)}</small></span></div><span className="text-sm text-tertiary transition-colors group-hover:text-foreground">{workspace.lifecycleStatus && workspace.lifecycleStatus !== "active" ? "View" : "Open"}</span></Link>)}</div>;
}

function WorkspaceLifecycleBadge({ workspace }: { workspace: Workspace }) {
  const status = workspace.lifecycleStatus ?? "active";
  if (status === "active") return null;
  return <Badge className="shrink-0" variant={status === "archived" ? "warning" : "error"} label={status[0]!.toUpperCase() + status.slice(1)} />;
}

function WorkspaceEmpty({ onCreate }: { onCreate: () => void }) {
  return <PageState state="empty"><EmptyState icon={<FolderKanban />} title="No workspaces yet" description="Create a workspace to organize projects, endpoints, files, and tasks." actions={<Button label="New workspace" variant="primary" onClick={onCreate} />} /></PageState>;
}

function WorkspaceError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <PageState state="error"><ErrorState title="Workspace directory unavailable" message={message} onRetry={() => void onRetry()} /></PageState>;
}

function CreateWorkspaceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (workspace: Workspace) => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mutationKeys = useMutationKeys();
  useEffect(() => {
    if (open) {
      setName("");
      setError("");
      mutationKeys.clear("workspace.create");
    }
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (saving || !nextName) return;
    const requestIdentity = nextName;
    setSaving(true);
    setError("");
    try {
      const workspace = await apiClient.createWorkspace(nextName, mutationKeys.key("workspace.create", requestIdentity));
      mutationKeys.complete("workspace.create", requestIdentity);
      onCreated(workspace);
      toast.success("Workspace created");
      setName("");
    } catch (reason) {
      if (reason instanceof ApiError) mutationKeys.complete("workspace.create", requestIdentity);
      setError(errorMessage(reason, "Workspace could not be created."));
    } finally {
      setSaving(false);
    }
  }
  const handleOpenChange = (next: boolean) => {
    if (saving || next) return;
    mutationKeys.clear("workspace.create");
    onClose();
  };
  return <Dialog isOpen={open} onOpenChange={handleOpenChange} purpose="info" width="min(34rem, calc(100vw - 2rem))" padding={0} aria-label="New workspace"><form onSubmit={submit}><DialogHeader title="New workspace" subtitle="Create a home for one or more projects." hasDivider padding={5} /><div className="px-6 py-5"><label className="grid gap-2 text-sm text-primary">Name<Input autoFocus data-autofocus required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} disabled={saving} /></label>{error ? <p className="mt-3 text-sm text-error" role="alert">{error}</p> : null}</div><footer className="flex justify-end gap-2 border-t border-subtle px-6 py-4"><Button type="button" label="Cancel" variant="ghost" isDisabled={saving} onClick={() => handleOpenChange(false)} /><Button type="submit" label="Create workspace" variant="primary" isDisabled={name.trim().length === 0} isLoading={saving} /></footer></form></Dialog>;
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}

function workspaceOwnerLabel(workspace: Workspace): string { return workspace.owner?.displayName || workspace.owner?.email || "Workspace owner"; }
function roleLabel(role: WorkspaceMemberRole | undefined): string { return role ? role[0]!.toUpperCase() + role.slice(1) : "Member"; }
