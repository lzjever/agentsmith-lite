"use client";

import { FolderKanban, Plus } from "lucide-react";
import Link from "next/link";
import { Badge, Banner, Button, EmptyState, Spinner, Text, TextInput, useToast } from "@astryxdesign/core";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, apiClient, type Workspace, type WorkspaceMemberRole } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { Dialog } from "../ui/Dialog";

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
    {state === "loading" ? <div className="flex min-h-48 items-center justify-center"><Spinner label="Loading workspaces..." /></div> : null}
    {state === "error" ? <WorkspaceError message={error} onRetry={load} /> : null}
    {state === "ready" && workspaces.length === 0 ? <WorkspaceEmpty onCreate={() => setCreateOpen(true)} /> : null}
    {state === "ready" && workspaces.length > 0 ? <WorkspaceList workspaces={workspaces} /> : null}
    <CreateWorkspaceDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(workspace) => { setWorkspaces((items) => [...items, workspace]); setCreateOpen(false); }} />
  </PageLayout>;
}

function WorkspaceList({ workspaces }: { workspaces: Workspace[] }) {
  return <div className="divide-y divide-border border-y border-border">{workspaces.map((workspace) => <Link key={workspace.id} href={`/workspaces/${workspace.id}`} className="group flex items-center justify-between gap-5 px-2 py-5 no-underline hover:bg-overlay-hover"><div className="flex min-w-0 items-center gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-sm bg-muted text-icon-secondary"><FolderKanban size={18} /></span><span className="min-w-0"><span className="flex min-w-0 items-center gap-2"><Text weight="medium" maxLines={1}>{workspace.name}</Text><WorkspaceLifecycleBadge workspace={workspace} /></span><Text type="supporting" color="secondary" display="block" className="mt-1">{workspace.projects.length} {workspace.projects.length === 1 ? "project" : "projects"}</Text><Text type="supporting" color="secondary" display="block" maxLines={1} className="mt-1">Owner: {workspaceOwnerLabel(workspace)} · Your access: {roleLabel(workspace.memberRole)}</Text></span></div><Text type="supporting" color="secondary" className="group-hover:text-primary">{workspace.lifecycleStatus && workspace.lifecycleStatus !== "active" ? "View" : "Open"}</Text></Link>)}</div>;
}

function WorkspaceLifecycleBadge({ workspace }: { workspace: Workspace }) {
  const status = workspace.lifecycleStatus ?? "active";
  if (status === "active") return null;
  return <Badge className="shrink-0" variant={status === "archived" ? "warning" : "error"} label={status[0]!.toUpperCase() + status.slice(1)} />;
}

function WorkspaceEmpty({ onCreate }: { onCreate: () => void }) {
  return <EmptyState icon={<FolderKanban />} title="No workspaces yet" description="Create a workspace to organize projects, endpoints, files, and tasks." actions={<Button label="New workspace" variant="primary" onClick={onCreate} />} />;
}

function WorkspaceError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <Banner status="error" title="Workspace directory unavailable" description={message} endContent={<Button label="Try again" variant="secondary" onClick={() => void onRetry()} />} />;
}

function CreateWorkspaceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (workspace: Workspace) => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
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
      showToast({ body: "Workspace created" });
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
  return <Dialog isOpen={open} onOpenChange={handleOpenChange} title="New workspace" subtitle="Create a home for one or more projects." busy={saving} primaryAction={<Button type="submit" form="workspace-create-form" label="Create workspace" variant="primary" isDisabled={saving || name.trim().length === 0} isLoading={saving} />}><form id="workspace-create-form" onSubmit={submit}><TextInput label="Name" value={name} onChange={(value) => setName(value.slice(0, 160))} isRequired hasAutoFocus isDisabled={saving} {...(error && { status: { type: "error", message: error } as const })} width="100%" /></form></Dialog>;
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}

function workspaceOwnerLabel(workspace: Workspace): string { return workspace.owner?.displayName || workspace.owner?.email || "Workspace owner"; }
function roleLabel(role: WorkspaceMemberRole | undefined): string { return role ? role[0]!.toUpperCase() + role.slice(1) : "Member"; }
