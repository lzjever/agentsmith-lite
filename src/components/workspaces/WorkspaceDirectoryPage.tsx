"use client";

import { FolderKanban, Plus } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, apiClient, type Workspace, type WorkspaceMemberRole } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { ErrorState } from "../ui/error-state";
import { EmptyState, PageLoading } from "../ui/loading";
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

  return <PageLayout header={<PageHeader title="Workspaces" subtitle="Choose a workspace to continue into its projects." actions={<Button disabled={state !== "ready"} onClick={() => setCreateOpen(true)}><Plus size={16} />New workspace</Button>} />}>
    {state === "loading" ? <PageState state="loading"><PageLoading /></PageState> : null}
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
  return <Badge className="shrink-0" variant={status === "archived" ? "warning" : "destructive"}>{status[0]!.toUpperCase() + status.slice(1)}</Badge>;
}

function WorkspaceEmpty({ onCreate }: { onCreate: () => void }) {
  return <PageState state="empty"><EmptyState icon={FolderKanban} title="No workspaces yet" description="Create a workspace to organize projects, endpoints, files, and tasks." action={{ label: "New workspace", onClick: onCreate }} /></PageState>;
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
    if (!nextName) return;
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
  return <Dialog open={open} onOpenChange={(next) => { if (!saving && !next) { mutationKeys.clear("workspace.create"); onClose(); } }}><DialogContent><form onSubmit={submit}><DialogHeader><p className="type-caption text-tertiary">Workspace</p><DialogTitle className="type-title mt-2 block">New workspace</DialogTitle><DialogDescription className="mt-1 text-sm text-secondary">Create a home for one or more projects.</DialogDescription></DialogHeader><div className="px-6 py-5"><label className="grid gap-2 text-sm text-primary">Name<Input autoFocus required value={name} onChange={(event) => setName(event.target.value)} disabled={saving} /></label>{error ? <p className="mt-3 text-sm text-error" role="alert">{error}</p> : null}</div><footer className="flex justify-end gap-2 border-t border-subtle px-6 py-4"><DialogClose asChild><Button variant="quiet" disabled={saving}>Cancel</Button></DialogClose><Button type="submit" disabled={saving || name.trim().length === 0}>{saving ? "Creating..." : "Create workspace"}</Button></footer></form></DialogContent></Dialog>;
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}

function workspaceOwnerLabel(workspace: Workspace): string { return workspace.owner?.displayName || workspace.owner?.email || "Workspace owner"; }
function roleLabel(role: WorkspaceMemberRole | undefined): string { return role ? role[0]!.toUpperCase() + role.slice(1) : "Member"; }
