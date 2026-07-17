"use client";

import { Plus, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type Workspace, type WorkspaceMember, type WorkspaceMemberRole } from "../../lib/api/client";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ConfirmationDialog } from "../ui/confirmation-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "../ui/dialog";
import { ErrorState } from "../ui/error-state";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

type MutationError = { message: string; retry?: () => void };

export function WorkspaceMembersPage({ workspaceId }: { workspaceId: string }) {
  return <WorkspaceMembers key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceMembers({ workspaceId }: { workspaceId: string }) {
  const mutationKeys = useMutationKeys();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const refreshRequest = useRef(0);
  const workspaceRequest = useRef(0);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Exclude<WorkspaceMemberRole, "owner">>("member");
  const [busyUserId, setBusyUserId] = useState<string>();
  const [mutationError, setMutationError] = useState<MutationError>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<WorkspaceMember>();
  const [memberToRemove, setMemberToRemove] = useState<WorkspaceMember>();

  const refreshWorkspace = useCallback(async () => {
    const request = ++workspaceRequest.current;
    const workspaces = await apiClient.workspaces();
    const found = workspaces.find((item) => item.id === workspaceId);
    if (!found) throw new ApiError(404, "Workspace not found");
    if (!mounted.current || request !== workspaceRequest.current) return;
    setWorkspace(found);
  }, [workspaceId]);

  const refresh = useCallback(async () => {
    const request = ++refreshRequest.current;
    const [, listed] = await Promise.all([refreshWorkspace(), apiClient.workspaceMembers(workspaceId)]);
    if (!mounted.current || request !== refreshRequest.current) return;
    setMembers(listed);
    setState("ready");
  }, [refreshWorkspace, workspaceId]);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setState("loading");
    setMutationError(undefined);
    try {
      await refresh();
    } catch {
      if (!mounted.current || request !== loadRequest.current) return;
      setState("error");
    }
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!open) mutationKeys.clear("workspace-member.add"); }, [open]);

  const canManage = workspace?.capabilities.canManageMembers === true;
  const mutationBusy = busyUserId !== undefined;
  const filtered = useMemo(() => members.filter((member) => `${member.displayName ?? ""} ${member.email} ${member.role}`.toLowerCase().includes(query.trim().toLowerCase())), [members, query]);

  async function recoverMutation(reason: unknown, retry: () => void) {
    const accessDenied = isReadOnlyMutationError(reason);
    if (reason instanceof ApiError && reason.status === 404 && reason.message === "Workspace not found") {
      setWorkspace(undefined);
      setMembers([]);
      setSelected(undefined);
      setOpen(false);
      setMemberToRemove(undefined);
      setMutationError(undefined);
      setState("error");
      return;
    }
    if (reason instanceof ApiError && reason.status === 403) {
      setWorkspace(undefined);
      setMembers([]);
      setSelected(undefined);
      setOpen(false);
      setMemberToRemove(undefined);
      setMutationError(undefined);
      setState("loading");
      try {
        await refresh();
      } catch {
        if (mounted.current) setState("error");
        return;
      }
      if (!mounted.current) return;
      setWorkspace((current) => current ? { ...current, capabilities: { ...current.capabilities, canManageMembers: false } } : current);
      setMutationError({ message: errorMessage(reason) });
      return;
    }
    try {
      await refresh();
    } catch (refreshReason) {
      if (refreshReason instanceof ApiError && (refreshReason.status === 403 || (refreshReason.status === 404 && refreshReason.message === "Workspace not found"))) {
        setWorkspace(undefined);
        setMembers([]);
        setSelected(undefined);
        setOpen(false);
        setMemberToRemove(undefined);
        setMutationError(undefined);
        setState("error");
        return;
      }
      // Preserve the original mutation error while the page remains usable.
    }
    if (!mounted.current) return;
    if (accessDenied) {
      setWorkspace((current) => current ? { ...current, capabilities: { ...current.capabilities, canManageMembers: false } } : current);
      setOpen(false);
      setMemberToRemove(undefined);
    }
    setMutationError({ message: errorMessage(reason), ...(!accessDenied && { retry }) });
  }

  async function add() {
    if (!canManage || mutationBusy || !email.trim()) return;
    setBusyUserId("new");
    setMutationError(undefined);
    try {
      const added = await apiClient.addWorkspaceMember(workspaceId, email.trim(), role, mutationKeys.key("workspace-member.add", workspaceId));
      mutationKeys.complete("workspace-member.add", workspaceId);
      if (!mounted.current) return;
      setMembers((current) => [...current.filter((member) => member.userId !== added.userId), added]);
      setOpen(false);
      setEmail("");
      setRole("member");
      void refreshWorkspace().catch(() => undefined);
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError) mutationKeys.complete("workspace-member.add", workspaceId);
      await recoverMutation(reason, () => void add());
    } finally {
      if (mounted.current) setBusyUserId(undefined);
    }
  }

  async function change(member: WorkspaceMember, next: Exclude<WorkspaceMemberRole, "owner">) {
    if (!canManage || mutationBusy) return;
    setBusyUserId(member.userId);
    setMutationError(undefined);
    const requestIdentity = `${member.userId}:${next}`;
    try {
      const changed = await apiClient.changeWorkspaceMember(workspaceId, member.userId, next, mutationKeys.key("workspace-member.change", requestIdentity));
      mutationKeys.complete("workspace-member.change", requestIdentity);
      if (!mounted.current) return;
      setMembers((current) => current.map((item) => item.userId === changed.userId ? changed : item));
      void refreshWorkspace().catch(() => undefined);
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError) mutationKeys.complete("workspace-member.change", requestIdentity);
      await recoverMutation(reason, () => void change(member, next));
      if (reason instanceof ApiError && reason.status === 404 && reason.message === "Workspace membership not found") {
        setMutationError(undefined);
      }
    } finally {
      if (mounted.current) setBusyUserId(undefined);
    }
  }

  async function remove(member: WorkspaceMember) {
    if (!canManage || mutationBusy) return;
    setBusyUserId(member.userId);
    setMutationError(undefined);
    try {
      await apiClient.removeWorkspaceMember(workspaceId, member.userId, mutationKeys.key("workspace-member.remove", member.userId));
      mutationKeys.complete("workspace-member.remove", member.userId);
      if (!mounted.current) return;
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
      void refreshWorkspace().catch(() => undefined);
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError) mutationKeys.complete("workspace-member.remove", member.userId);
      await recoverMutation(reason, () => void remove(member));
      if (reason instanceof ApiError && reason.status === 404 && reason.message === "Workspace membership not found") {
        setMutationError(undefined);
        setMemberToRemove(undefined);
        return;
      }
      throw reason;
    } finally {
      if (mounted.current) setBusyUserId(undefined);
    }
  }

  return <PageLayout header={<PageHeader title="Workspace members" subtitle="People with access to this workspace." actions={canManage ? <Button disabled={mutationBusy} onClick={() => { setMutationError(undefined); setOpen(true); }}><Plus size={16} />Add member</Button> : undefined} />}>
    {state === "loading" ? <PageState>Loading workspace members...</PageState> : null}
    {state === "error" ? <PageState state="error"><ErrorState title="Workspace members unavailable" message="The workspace members could not be loaded." onRetry={() => void load()} /></PageState> : null}
    {state === "ready" ? <section className="space-y-4" aria-label="Workspace members">
      {mutationError && !open ? <MutationNotice error={mutationError} onDismiss={() => setMutationError(undefined)} /> : null}
      <label className="relative block max-w-sm"><span className="sr-only">Search workspace members</span><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary" /><Input className="h-9 pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search members" /></label>
      {filtered.length === 0 ? <PageState state="empty">No workspace members match this search.</PageState> : <div className="divide-y divide-border border-y border-border">{filtered.map((member) => <WorkspaceMemberRow key={member.userId} member={member} canManage={canManage} busy={mutationBusy} onChange={change} onRemove={setMemberToRemove} onView={setSelected} />)}</div>}
      {!canManage ? <p className="text-sm text-secondary">Your workspace access is read-only.</p> : null}
    </section> : null}
    <Dialog open={open} onOpenChange={(next) => { if (!mutationBusy) setOpen(next); }}><DialogContent><DialogHeader title="Add workspace member" description="Grant an existing identity access to this workspace." />{mutationError ? <div className="px-5 pt-4"><MutationNotice error={mutationError} onDismiss={() => setMutationError(undefined)} /></div> : null}<div className="grid gap-4 px-5 py-5"><label className="grid gap-2 text-sm text-primary">Email<Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" disabled={mutationBusy} /></label><Select value={role} disabled={mutationBusy} onValueChange={(value) => setRole(value as Exclude<WorkspaceMemberRole, "owner">)}><SelectTrigger aria-label="Workspace member role"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="admin">Admin</SelectItem><SelectItem value="member">Member</SelectItem><SelectItem value="viewer">Viewer</SelectItem></SelectContent></Select></div><DialogFooter><Button variant="quiet" onClick={() => setOpen(false)} disabled={mutationBusy}>Cancel</Button><Button disabled={!email.trim() || !canManage || mutationBusy} onClick={() => void add()}>{busyUserId === "new" ? "Adding..." : "Add member"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(selected)} onOpenChange={(next) => !next && setSelected(undefined)}><DialogContent>{selected ? <><DialogHeader title="Member details" description="Workspace membership identity." /><dl className="grid gap-4 px-5 py-5 text-sm sm:grid-cols-[8rem_1fr]"><dt className="text-secondary">Name</dt><dd className="break-all text-foreground">{memberLabel(selected)}</dd><dt className="text-secondary">Email</dt><dd className="break-all text-foreground">{selected.email}</dd><dt className="text-secondary">Role</dt><dd>{selected.role}</dd><dt className="text-secondary">Joined</dt><dd>{new Date(selected.createdAt).toLocaleString("en-US")}</dd></dl></> : null}</DialogContent></Dialog>
    <ConfirmationDialog open={Boolean(memberToRemove)} onOpenChange={(next) => !next && setMemberToRemove(undefined)} title="Remove workspace member" description={memberToRemove ? `Remove ${memberLabel(memberToRemove)} from this workspace? They will lose access to its projects.` : undefined} confirmText="Remove member" confirmDisabled={mutationBusy} onConfirm={() => memberToRemove ? remove(memberToRemove) : undefined} errorContext="Workspace member could not be removed" />
  </PageLayout>;
}

function WorkspaceMemberRow({ member, canManage, busy, onChange, onRemove, onView }: { member: WorkspaceMember; canManage: boolean; busy: boolean; onChange: (member: WorkspaceMember, role: Exclude<WorkspaceMemberRole, "owner">) => void; onRemove: (member: WorkspaceMember) => void; onView: (member: WorkspaceMember) => void }) {
  const label = memberLabel(member);
  return <div className="flex flex-wrap items-center justify-between gap-3 py-3"><button type="button" className="min-w-0 text-left" onClick={() => onView(member)}><div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm text-foreground">{label}</p>{member.role === "owner" ? <Badge variant="outline">Owner</Badge> : null}</div>{member.displayName ? <p className="truncate text-xs text-secondary">{member.email}</p> : null}{member.role !== "owner" ? <p className="mt-1 text-xs text-secondary">{roleLabel(member.role)}</p> : null}</button>{canManage && member.role !== "owner" ? <div className="flex gap-2"><Select value={member.role} disabled={busy} onValueChange={(value) => onChange(member, value as Exclude<WorkspaceMemberRole, "owner">)}><SelectTrigger aria-label={`Role for ${label}`} className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="admin">Admin</SelectItem><SelectItem value="member">Member</SelectItem><SelectItem value="viewer">Viewer</SelectItem></SelectContent></Select><Button variant="danger" size="icon" aria-label={`Remove ${label}`} disabled={busy} onClick={() => void onRemove(member)}><Trash2 size={15} /></Button></div> : null}</div>;
}

function MutationNotice({ error, onDismiss }: { error: MutationError; onDismiss: () => void }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert"><span>{error.message}</span><span className="flex gap-2">{error.retry ? <Button size="sm" variant="quiet" onClick={error.retry}>Retry</Button> : null}<Button size="icon" variant="quiet" aria-label="Dismiss member error" onClick={onDismiss}><X size={15} /></Button></span></div>;
}

function memberLabel(member: WorkspaceMember): string { return member.displayName || member.email || "Workspace member"; }
function roleLabel(role: Exclude<WorkspaceMemberRole, "owner">): string { return role[0]!.toUpperCase() + role.slice(1); }
function errorMessage(reason: unknown): string { return reason instanceof ApiError ? reason.message : "The member request could not be completed."; }
