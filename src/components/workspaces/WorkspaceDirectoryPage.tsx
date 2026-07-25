"use client";

import { FolderKanban, Plus } from "lucide-react";
import Link from "next/link";
import { Badge, Banner, Button, Dialog, DialogHeader, EmptyState, Spinner, Text, TextInput, useToast } from "@astryxdesign/core";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, apiClient, notifyDirectoryChanged, type WorkspaceDetail, type WorkspaceDirectoryItem, type WorkspaceMemberRole } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";

type LoadState = "loading" | "ready" | "error";

export function WorkspaceDirectoryPage() {
  const [workspaces, setWorkspaces] = useState<WorkspaceDirectoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [currentCursor, setCurrentCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  async function load(cursor?:string) {
    setState("loading");
    setError("");
    try {
      const page=await apiClient.workspaces({...(cursor?{cursor}:{}),limit:20});
      setWorkspaces(page.items);
      setNextCursor(page.nextCursor);
      setCurrentCursor(cursor);
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
    {state === "ready" && workspaces.length > 0 ? <><WorkspaceList workspaces={workspaces} /><div className="mt-4 flex items-center justify-end gap-2"><Button label="Previous" variant="secondary" size="sm" isDisabled={cursorHistory.length===0} onClick={()=>{const history=cursorHistory.slice(0,-1);const previous=cursorHistory.at(-1)||undefined;setCursorHistory(history);void load(previous);}}/><Text type="supporting" color="secondary">Page {cursorHistory.length+1}</Text><Button label="Next" variant="secondary" size="sm" isDisabled={!nextCursor} onClick={()=>{if(!nextCursor)return;setCursorHistory((items)=>[...items,currentCursor??""]);void load(nextCursor);}}/></div></> : null}
    <CreateWorkspaceDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); setCursorHistory([]); void load(); }} />
  </PageLayout>;
}

function WorkspaceList({ workspaces }: { workspaces: WorkspaceDirectoryItem[] }) {
  return <div className="divide-y divide-border border-y border-border">{workspaces.map((workspace) => <Link key={workspace.id} href={`/workspaces/${workspace.id}`} className="group flex items-center justify-between gap-5 px-2 py-5 no-underline hover:bg-overlay-hover"><div className="flex min-w-0 items-center gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-sm bg-muted text-icon-secondary"><FolderKanban size={18} /></span><span className="min-w-0"><span className="flex min-w-0 items-center gap-2"><Text weight="medium" maxLines={1}>{workspace.name}</Text><WorkspaceLifecycleBadge workspace={workspace} /></span><Text type="supporting" color="secondary" display="block" className="mt-1">{workspace.projectCount} {workspace.projectCount === 1 ? "project" : "projects"}</Text><Text type="supporting" color="secondary" display="block" maxLines={1} className="mt-1">Owner: {workspaceOwnerLabel(workspace)} · Your access: {roleLabel(workspace.memberRole)}</Text></span></div><Text type="supporting" color="secondary" className="group-hover:text-primary">{workspace.lifecycleStatus && workspace.lifecycleStatus !== "active" ? "View" : "Open"}</Text></Link>)}</div>;
}

function WorkspaceLifecycleBadge({ workspace }: { workspace: WorkspaceDirectoryItem }) {
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

function CreateWorkspaceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (workspace: WorkspaceDetail) => void }) {
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
      notifyDirectoryChanged();
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
  return <Dialog className="[&_button]:min-h-11 [&_button]:min-w-11" isOpen={open} onOpenChange={handleOpenChange} purpose="form" padding={0} width="min(34rem, calc(100dvw - 1rem))" maxHeight="calc(100dvh - 1rem)" aria-label="New workspace">
    <DialogHeader title="New workspace" subtitle="Create a home for one or more projects." hasDivider {...(!saving ? { onOpenChange: handleOpenChange } : {})} />
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"><form id="workspace-create-form" onSubmit={submit}><TextInput label="Name" value={name} onChange={(value) => setName(value.slice(0, 160))} isRequired hasAutoFocus data-autofocus="" isDisabled={saving} {...(error && { status: { type: "error", message: error } as const })} width="100%" /></form></div>
    <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 border-t border-border p-4 sm:flex sm:justify-end sm:px-6 [@media(max-height:20rem)]:!grid [@media(max-height:20rem)]:grid-cols-2 [@media(max-height:20rem)]:!p-2 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-auto [@media(max-height:20rem)]:[&>*]:w-full [&_button]:!h-auto [&_button]:min-w-0 [&_button]:whitespace-normal">
      <Button type="button" label="Cancel" variant="ghost" size="lg" isDisabled={saving} onClick={() => handleOpenChange(false)} />
      <Button type="submit" form="workspace-create-form" label="Create workspace" variant="primary" size="lg" isDisabled={saving || name.trim().length === 0} isLoading={saving} />
    </div>
  </Dialog>;
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}

function workspaceOwnerLabel(workspace: WorkspaceDirectoryItem): string { return workspace.owner.displayName || workspace.owner.email || "Workspace owner"; }
function roleLabel(role: WorkspaceMemberRole | undefined): string { return role ? role[0]!.toUpperCase() + role.slice(1) : "Member"; }
