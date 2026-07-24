"use client";

import { Plus, Search, Trash2, X } from "lucide-react";
import { Badge, Banner, Button, Dialog, DialogHeader, EmptyState, IconButton, Selector, Spinner, Text, TextInput } from "@astryxdesign/core";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type Workspace, type WorkspaceMember, type WorkspaceMemberRole } from "../../lib/api/client";
import { formatLocalDateTime } from "../../lib/format/date";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";

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
    return listed;
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
  const handleMemberOpenChange = (next: boolean) => {
    if (!mutationBusy) setOpen(next);
  };
  const filtered = useMemo(() => members.filter((member) => `${member.displayName ?? ""} ${member.email} ${member.role}`.toLowerCase().includes(query.trim().toLowerCase())), [members, query]);

  async function recoverMutation(reason: unknown, retry: () => void) {
    const accessDenied = isReadOnlyMutationError(reason);
    let refreshed: WorkspaceMember[] | undefined;
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
      refreshed = await refresh();
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
    if (refreshed) {
      setSelected((current) => current ? refreshed!.find((member) => member.userId === current.userId) : undefined);
      setMemberToRemove((current) => current ? refreshed!.find((member) => member.userId === current.userId) : undefined);
    }
    if (accessDenied) {
      setWorkspace((current) => current ? { ...current, capabilities: { ...current.capabilities, canManageMembers: false } } : current);
      setOpen(false);
      setMemberToRemove(undefined);
    }
    const stale = reason instanceof ApiError && reason.status === 409 && reason.message === "Workspace membership changed elsewhere. Reload and try again.";
    setMutationError({ message: errorMessage(reason), ...(!accessDenied && !stale && { retry }) });
  }

  async function add(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!canManage || mutationBusy || !email.trim()) return;
    setBusyUserId("new");
    setMutationError(undefined);
    try {
      const added = await apiClient.addWorkspaceMember(workspaceId, email.trim(), role, mutationKeys.requestKey("workspace-member.add", workspaceId, { email: email.trim(), role }));
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
      const changed = await apiClient.changeWorkspaceMember(workspaceId, member.userId, next, member.updatedAt, mutationKeys.key("workspace-member.change", requestIdentity));
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
      await apiClient.removeWorkspaceMember(workspaceId, member.userId, member.updatedAt, mutationKeys.key("workspace-member.remove", member.userId));
      mutationKeys.complete("workspace-member.remove", member.userId);
      if (!mounted.current) return;
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
      setMemberToRemove(undefined);
      setMutationError(undefined);
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
    } finally {
      if (mounted.current) setBusyUserId(undefined);
    }
  }

  return <PageLayout header={<PageHeader title="Workspace members" subtitle="People with access to this workspace." actions={canManage ? <Button label="Add member" icon={<Plus size={16} />} variant="primary" size="lg" isDisabled={mutationBusy} onClick={() => { setMutationError(undefined); setOpen(true); }} /> : undefined} />}>
    {state === "loading" ? <div className="flex min-h-48 items-center justify-center"><Spinner label="Loading workspace members..." /></div> : null}
    {state === "error" ? <Banner status="error" title="Workspace members unavailable" description="The workspace members could not be loaded." endContent={<Button label="Try again" variant="secondary" onClick={() => void load()} />} /> : null}
    {state === "ready" ? <section className="space-y-4" aria-label="Workspace members">
      {mutationError && !open && !memberToRemove ? <MutationNotice error={mutationError} onDismiss={() => setMutationError(undefined)} /> : null}
      <TextInput label="Search workspace members" isLabelHidden startIcon={<Search size={16} />} value={query} onChange={setQuery} className="max-w-sm" placeholder="Search members" size="lg" />
      {filtered.length === 0 ? <EmptyState title="No workspace members match this search" /> : <div className="divide-y divide-border border-y border-border">{filtered.map((member) => <WorkspaceMemberRow key={member.userId} member={member} canManage={canManage} busy={mutationBusy} onChange={change} onRemove={(next) => { setMutationError(undefined); setMemberToRemove(next); }} onView={setSelected} />)}</div>}
      {!canManage ? <Text type="supporting" color="secondary">Your workspace access is read-only.</Text> : null}
    </section> : null}
    <Dialog isOpen={open} onOpenChange={handleMemberOpenChange} purpose="form" width="min(34rem, calc(100vw - 2rem))" padding={0} aria-label="Add workspace member"><form onSubmit={add}><DialogHeader title="Add workspace member" subtitle="Grant an existing identity access to this workspace." onOpenChange={handleMemberOpenChange} hasDivider />{mutationError ? <div className="px-5 pt-4"><MutationNotice error={mutationError} onDismiss={() => setMutationError(undefined)} /></div> : null}<div className="grid gap-4 px-5 py-5"><TextInput label="Email" value={email} onChange={setEmail} type="email" isDisabled={mutationBusy} width="100%" /><Selector label="Workspace member role" options={[{ value: "admin", label: "Admin" }, { value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }]} value={role} onChange={(value) => setRole(value as Exclude<WorkspaceMemberRole, "owner">)} isDisabled={mutationBusy} size="lg" /></div><footer className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end md:px-6"><Button label="Cancel" type="button" variant="ghost" size="lg" onClick={() => handleMemberOpenChange(false)} isDisabled={mutationBusy} /><Button label={busyUserId === "new" ? "Adding..." : "Add member"} type="submit" variant="primary" size="lg" isDisabled={!email.trim() || !canManage || mutationBusy} isLoading={busyUserId === "new"} /></footer></form></Dialog>
    <Dialog isOpen={Boolean(selected)} onOpenChange={(next) => !next && setSelected(undefined)} purpose="info" width="min(34rem, calc(100vw - 2rem))" padding={0} aria-label="Member details">{selected ? <><DialogHeader title="Member details" subtitle="Workspace membership identity." onOpenChange={(next) => !next && setSelected(undefined)} hasDivider /><dl className="grid gap-4 px-5 py-5 sm:grid-cols-[8rem_1fr]"><dt><Text color="secondary">Name</Text></dt><dd><Text wordBreak="break-all">{memberLabel(selected)}</Text></dd><dt><Text color="secondary">Email</Text></dt><dd><Text wordBreak="break-all">{selected.email}</Text></dd><dt><Text color="secondary">Role</Text></dt><dd><Text>{selected.role}</Text></dd><dt><Text color="secondary">Joined</Text></dt><dd><Text>{formatLocalDateTime(selected.createdAt)}</Text></dd></dl></> : null}</Dialog>
    <Dialog isOpen={Boolean(memberToRemove)} onOpenChange={(next) => { if (mutationBusy) return; if (!next) { setMemberToRemove(undefined); setMutationError(undefined); } }} purpose="form" role="alertdialog" width="min(32rem, calc(100vw - 2rem))" padding={0} aria-label="Remove workspace member"><DialogHeader title="Remove workspace member" subtitle={memberToRemove ? `Remove ${memberLabel(memberToRemove)} from this workspace? They will lose access to its projects.` : "This member is no longer available."} onOpenChange={(next) => { if (!next && !mutationBusy) setMemberToRemove(undefined); }} hasDivider />{mutationError ? <div className="px-5 pt-4"><MutationNotice error={mutationError} onDismiss={() => setMutationError(undefined)} /></div> : null}<footer className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end md:px-6"><Button label="Cancel" variant="ghost" size="lg" isDisabled={mutationBusy} onClick={() => setMemberToRemove(undefined)} /><Button label="Remove member" variant="destructive" size="lg" isDisabled={!memberToRemove || mutationBusy} isLoading={Boolean(memberToRemove && busyUserId === memberToRemove.userId)} onClick={() => { if (memberToRemove) void remove(memberToRemove); }} /></footer></Dialog>
  </PageLayout>;
}

function WorkspaceMemberRow({ member, canManage, busy, onChange, onRemove, onView }: { member: WorkspaceMember; canManage: boolean; busy: boolean; onChange: (member: WorkspaceMember, role: Exclude<WorkspaceMemberRole, "owner">) => void; onRemove: (member: WorkspaceMember) => void; onView: (member: WorkspaceMember) => void }) {
  const label = memberLabel(member);
  return <div className="flex flex-wrap items-center justify-between gap-3 py-3"><button type="button" className="min-w-0 text-left" onClick={() => onView(member)}><div className="flex flex-wrap items-center gap-2"><Text maxLines={1}>{label}</Text>{member.role === "owner" ? <Badge variant="neutral" label="Owner" /> : null}</div>{member.displayName ? <Text type="supporting" color="secondary" display="block" maxLines={1}>{member.email}</Text> : null}{member.role !== "owner" ? <Text type="supporting" color="secondary" display="block" className="mt-1">{roleLabel(member.role)}</Text> : null}</button>{canManage && member.role !== "owner" ? <div className="flex gap-2"><Selector label={`Role for ${label}`} isLabelHidden options={[{ value: "admin", label: "Admin" }, { value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }]} value={member.role} onChange={(value) => onChange(member, value as Exclude<WorkspaceMemberRole, "owner">)} isDisabled={busy} size="lg" className="w-28" /><IconButton label={`Remove ${label}`} icon={<Trash2 size={15} />} variant="destructive" size="lg" isDisabled={busy} onClick={() => void onRemove(member)} /></div> : null}</div>;
}

function MutationNotice({ error, onDismiss }: { error: MutationError; onDismiss: () => void }) {
  return <Banner status="error" title="Member update failed" description={error.message} endContent={<span className="flex gap-2">{error.retry ? <Button label="Retry" size="md" variant="ghost" onClick={error.retry} /> : null}<IconButton label="Dismiss member error" icon={<X size={15} />} size="lg" variant="ghost" onClick={onDismiss} /></span>} />;
}

function memberLabel(member: WorkspaceMember): string { return member.displayName || member.email || "Workspace member"; }
function roleLabel(role: Exclude<WorkspaceMemberRole, "owner">): string { return role[0]!.toUpperCase() + role.slice(1); }
function errorMessage(reason: unknown): string { return reason instanceof ApiError ? reason.message : "The member request could not be completed."; }
