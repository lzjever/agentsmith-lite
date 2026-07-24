"use client";

import Link from "next/link";
import { Banner, Button, Dialog, DialogHeader, EmptyState, IconButton, Selector, Spinner, Text, TextInput, useToast } from "@astryxdesign/core";
import { Plus, RefreshCw, Users, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiClient, isReadOnlyMutationError, type MemberRole, type ProjectCapabilities, type ProjectMember, type WorkspaceMember } from "../../lib/api/client";
import { formatLocalDateTime } from "../../lib/format/date";
import { useMutationKeys } from "../../lib/api/use-mutation-keys";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { memberIdentityLabel, memberMatchesQuery, removeMemberById } from "./members-page-utils";
import { MembersTable } from "./MembersTable";

export function MembersPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  return <ProjectMembersPage key={`${workspaceId}:${projectId}`} workspaceId={workspaceId} projectId={projectId} />;
}

function ProjectMembersPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const mutationKeys = useMutationKeys();
  const showToast = useToast();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const memberRequest = useRef(0);
  const candidateRequest = useRef(0);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [candidateState, setCandidateState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | MemberRole>("all");
  const [selected, setSelected] = useState<ProjectMember>();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [candidateUserId, setCandidateUserId] = useState("");
  const [role, setRole] = useState<Exclude<MemberRole, "owner">>("member");
  const [removing, setRemoving] = useState<ProjectMember>();
  const [busyUserId, setBusyUserId] = useState<string>();
  const [inviteError, setInviteError] = useState("");
  const [roleError, setRoleError] = useState<{ userId: string; message: string }>();
  const [removeError, setRemoveError] = useState("");

  const loadCandidates = useCallback(async () => {
    const request = ++candidateRequest.current;
    setCandidateState("loading");
    try {
      const listed = await apiClient.workspaceMembers(workspaceId);
      if (!mounted.current || request !== candidateRequest.current) return;
      setWorkspaceMembers(listed);
      setCandidateState("ready");
    } catch {
      if (!mounted.current || request !== candidateRequest.current) return;
      setCandidateState("error");
    }
  }, [workspaceId]);

  const refreshMembers = useCallback(async () => {
    const request = ++memberRequest.current;
    const listed = await apiClient.members(projectId);
    if (!mounted.current || request !== memberRequest.current) return undefined;
    setMembers(listed);
    return listed;
  }, [projectId]);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setState("loading");
    setError("");
    setCapabilities(undefined);
    setCapabilitiesError("");
    setWorkspaceMembers([]);
    setCandidateState("loading");
    const [membersResult, capabilitiesResult] = await Promise.allSettled([
      refreshMembers(),
      apiClient.projectCapabilities(projectId),
    ]);
    if (!mounted.current || request !== loadRequest.current) return;
    if (membersResult.status === "rejected") {
      setError(message(membersResult.reason));
      setState("error");
      return;
    }
    if (capabilitiesResult.status === "fulfilled") {
      setCapabilities(capabilitiesResult.value);
      if (capabilitiesResult.value.canManageMembers) void loadCandidates();
      else setCandidateState("ready");
    } else {
      setCapabilitiesError("Project permissions could not be loaded. Members are read-only until refreshed.");
      setCandidateState("ready");
    }
    setState("ready");
  }, [loadCandidates, projectId, refreshMembers]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!inviteOpen) mutationKeys.clear("project-member.add"); }, [inviteOpen]);

  const canManage = capabilities?.canManageMembers === true;
  const memberIds = useMemo(() => new Set(members.map((member) => member.userId)), [members]);
  const eligible = useMemo(() => workspaceMembers.filter((member) => !memberIds.has(member.userId)), [memberIds, workspaceMembers]);
  const canAdd = canManage && busyUserId === undefined && candidateState === "ready" && eligible.length > 0;
  const filtered = useMemo(() => members.filter((member) => memberMatchesQuery(member, query) && (roleFilter === "all" || member.role === roleFilter)), [members, query, roleFilter]);

  async function recoverMutationAccess(reason: unknown): Promise<boolean> {
    const projectMissing = reason instanceof ApiError && reason.status === 404 && reason.message === "Project not found";
    if (!projectMissing && !isReadOnlyMutationError(reason)) return false;
    setInviteOpen(false);
    setRemoving(undefined);
    if (projectMissing) {
      setMembers([]);
      setWorkspaceMembers([]);
      setCapabilities(undefined);
      setSelected(undefined);
      setRoleError(undefined);
      setError(reason.message);
      setState("error");
      return true;
    }
    if (reason.status === 403) {
      setMembers([]);
      setWorkspaceMembers([]);
      setCapabilities(undefined);
      setSelected(undefined);
      setRoleError(undefined);
      setState("loading");
      await load();
      return true;
    }
    setCapabilities((current) => current ? { ...current, canManageMembers: false } : current);
    setCapabilitiesError("Member management access changed. Members are now read-only.");
    return false;
  }

  function openInvite() {
    mutationKeys.clear("project-member.add");
    setInviteError("");
    setCandidateUserId(eligible[0]?.userId ?? "");
    setInviteOpen(true);
  }

  function handleInviteOpenChange(nextOpen: boolean) {
    if (!nextOpen && busyUserId === "new") return;
    setInviteOpen(nextOpen);
    if (!nextOpen) setInviteError("");
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdd || !candidateUserId) return;
    const candidate = eligible.find((member) => member.userId === candidateUserId);
    if (!candidate) return;
    setBusyUserId("new");
    setInviteError("");
    try {
      const added = await apiClient.addMember(projectId, candidateUserId, role, mutationKeys.requestKey("project-member.add", projectId, { candidateUserId, role }));
      mutationKeys.complete("project-member.add", projectId);
      if (!mounted.current) return;
      setMembers((current) => [...current.filter((member) => member.userId !== added.userId), added]);
      setInviteOpen(false);
      setCandidateUserId("");
      setRole("member");
      showToast({ body: "Member added" });
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError) mutationKeys.complete("project-member.add", projectId);
      const detail = message(reason);
      if (await recoverMutationAccess(reason)) return;
      setInviteError(detail);
      const [membersResult] = await Promise.allSettled([refreshMembers(), loadCandidates()]);
      if (membersResult.status === "rejected") await recoverMutationAccess(membersResult.reason);
    } finally {
      if (mounted.current) setBusyUserId(undefined);
    }
  }

  async function changeRole(member: ProjectMember, nextRole: Exclude<MemberRole, "owner">) {
    if (!canManage || busyUserId !== undefined) return;
    setBusyUserId(member.userId);
    setRoleError(undefined);
    try {
      const requestIdentity = `${member.userId}:${nextRole}`;
      const updated = await apiClient.changeMember(projectId, member.userId, nextRole, member.updatedAt, mutationKeys.key("project-member.change", requestIdentity));
      mutationKeys.complete("project-member.change", requestIdentity);
      if (!mounted.current) return;
      setMembers((current) => current.map((item) => item.userId === updated.userId ? updated : item));
      showToast({ body: "Member role updated" });
    } catch (reason) {
      if (!mounted.current) return;
      const requestIdentity = `${member.userId}:${nextRole}`;
      if (reason instanceof ApiError) mutationKeys.complete("project-member.change", requestIdentity);
      const detail = message(reason);
      if (await recoverMutationAccess(reason)) return;
      let refreshed: ProjectMember[] | undefined;
      try { refreshed = await refreshMembers(); } catch (refreshReason) {
        if (await recoverMutationAccess(refreshReason)) return;
      }
      if (!mounted.current) return;
      if (refreshed?.some((item) => item.userId === member.userId && item.role === nextRole)) {
        showToast({ body: "Member role updated" });
        return;
      }
      setRoleError({ userId: member.userId, message: detail });
    } finally {
      if (mounted.current) setBusyUserId(undefined);
    }
  }

  async function removeMember() {
    if (!removing || !canManage || busyUserId !== undefined) return;
    const member = removing;
    setBusyUserId(member.userId);
    setRemoveError("");
    try {
      await apiClient.removeMember(projectId, member.userId, member.updatedAt, mutationKeys.key("project-member.remove", member.userId));
      mutationKeys.complete("project-member.remove", member.userId);
      if (!mounted.current) return;
      setMembers((items) => removeMemberById(items, member.userId));
      setRemoving(undefined);
      setRemoveError("");
      showToast({ body: "Member removed" });
      void loadCandidates();
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError) mutationKeys.complete("project-member.remove", member.userId);
      const detail = message(reason);
      if (await recoverMutationAccess(reason)) return;
      let refreshed: ProjectMember[] | undefined;
      try { refreshed = await refreshMembers(); } catch (refreshReason) {
        if (await recoverMutationAccess(refreshReason)) return;
      }
      if (!mounted.current) return;
      if (refreshed && !refreshed.some((item) => item.userId === member.userId)) {
        mutationKeys.complete("project-member.remove", member.userId);
        setRemoving(undefined);
        setRemoveError("");
        showToast({ body: "Member removed" });
        void loadCandidates();
        return;
      }
      setRemoveError(detail);
    } finally {
      if (mounted.current) setBusyUserId(undefined);
    }
  }

  const workspaceMembersHref = `/workspaces/${workspaceId}/members`;
  return <PageLayout header={<PageHeader title="Members" subtitle="People with access to this project and the role they hold." actions={canAdd ? <Button label="Add member" variant="primary" size="lg" icon={<Plus size={16} />} onClick={openInvite} /> : undefined} />}>
    {state === "ready" && capabilitiesError ? <Banner status="warning" title="Project permissions unavailable" description={capabilitiesError} /> : null}
    {state === "loading" ? <div className="flex min-h-48 items-center justify-center"><Spinner label="Loading project members..." /></div> : null}
    {state === "error" ? <Banner status="error" title="Members unavailable" description={error} endContent={<Button label="Try again" variant="secondary" onClick={() => void load()} />} /> : null}
    {state === "ready" && members.length === 0 ? <EmptyState icon={<Users />} title="No project members" description="Project access begins with a workspace member." {...(canAdd ? { actions: <Button label="Add member" variant="primary" size="lg" onClick={openInvite} /> } : {})} /> : null}
    {state === "ready" && members.length > 0 ? <section className="space-y-4">
      {canManage && candidateState === "error" ? <Banner status="error" title="Workspace members unavailable" description="Workspace members could not be loaded. Existing project access is still available." endContent={<span className="flex items-center gap-2"><Button label="Retry" variant="ghost" size="md" icon={<RefreshCw size={14} />} onClick={() => void loadCandidates()} /><Link className="underline underline-offset-4" href={workspaceMembersHref}><Text type="supporting">Manage workspace members</Text></Link></span>} /> : null}
      {canManage && candidateState === "ready" && eligible.length === 0 ? <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-3"><Text type="supporting" color="secondary">All workspace members already have project access.</Text><Link className="text-primary underline underline-offset-4" href={workspaceMembersHref}>Manage workspace members</Link></div> : null}
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="relative min-w-[15rem] flex-1 sm:max-w-sm"><TextInput label="Search members" isLabelHidden value={query} onChange={setQuery} placeholder="Search by identity" size="lg" /></div><Selector label="Member role" isLabelHidden options={[{ value: "all", label: "All roles" }, { value: "owner", label: "Owner" }, { value: "admin", label: "Admin" }, { value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }]} value={roleFilter} onChange={(value) => setRoleFilter(value as typeof roleFilter)} size="sm" width={144} />{!canManage ? <Text type="supporting" color="secondary">Your project access is read-only.</Text> : null}</div>
      {filtered.length === 0 ? <EmptyState title="No members match these filters" actions={<Button label="Clear filters" variant="ghost" size="lg" onClick={() => { setQuery(""); setRoleFilter("all"); }} />} /> : <MembersTable members={filtered} canManage={canManage} busyUserId={busyUserId} roleError={roleError} onDismissRoleError={() => setRoleError(undefined)} onChangeRole={(member, nextRole) => void changeRole(member, nextRole)} onRemove={(member) => { setRemoveError(""); setRemoving(member); }} onView={setSelected} />}
    </section> : null}
    <Dialog isOpen={inviteOpen} onOpenChange={handleInviteOpenChange} purpose="form" width="min(34rem, calc(100vw - 2rem))" padding={0} aria-label="Add member"><form onSubmit={addMember}><DialogHeader title="Add member" subtitle="Choose someone who already belongs to this workspace." onOpenChange={handleInviteOpenChange} hasDivider />{inviteError ? <Banner className="mx-5 mt-4" status="error" title="Member could not be added" description={inviteError} endContent={<IconButton label="Dismiss member error" tooltip="Dismiss member error" variant="ghost" size="lg" icon={<X size={15} />} onClick={() => setInviteError("")} />} /> : null}<div className="grid gap-4 px-5 py-5"><Selector label="Workspace member" options={eligible.map((member) => ({ value: member.userId, label: workspaceMemberLabel(member) }))} value={candidateUserId} onChange={setCandidateUserId} placeholder="Select a workspace member" isDisabled={busyUserId === "new"} size="lg" /><Selector label="Role" options={[{ value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }, { value: "admin", label: "Admin" }]} value={role} onChange={(value) => setRole(value as Exclude<MemberRole, "owner">)} isDisabled={busyUserId === "new"} size="lg" /></div><footer className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end md:px-6"><Button type="button" label="Cancel" variant="ghost" size="lg" onClick={() => handleInviteOpenChange(false)} isDisabled={busyUserId === "new"} /><Button type="submit" label={busyUserId === "new" ? "Adding..." : "Add member"} variant="primary" size="lg" isDisabled={!canAdd || !candidateUserId || busyUserId === "new"} isLoading={busyUserId === "new"} /></footer></form></Dialog>
    <Dialog isOpen={Boolean(removing)} onOpenChange={(open) => { if (busyUserId !== undefined) return; if (!open) { setRemoving(undefined); setRemoveError(""); } }} purpose="form" role="alertdialog" width="min(32rem, calc(100vw - 2rem))" padding={0} aria-label="Remove member"><DialogHeader title="Remove member" subtitle={removing ? `Remove ${memberIdentityLabel(removing)} from this project? They will no longer be able to access its resources.` : "This member is no longer available."} onOpenChange={(open) => { if (!open && busyUserId === undefined) setRemoving(undefined); }} hasDivider />{removeError ? <Banner className="mx-5 mt-4" status="error" title="Member could not be removed" description={removeError} /> : null}<footer className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end md:px-6"><Button label="Cancel" variant="ghost" size="lg" isDisabled={busyUserId !== undefined} onClick={() => setRemoving(undefined)} /><Button label={busyUserId === removing?.userId ? "Removing" : "Remove member"} variant="destructive" size="lg" isDisabled={!canManage || busyUserId !== undefined} isLoading={busyUserId === removing?.userId} onClick={() => void removeMember()} /></footer></Dialog>
    <Dialog isOpen={Boolean(selected)} onOpenChange={(open) => !open && setSelected(undefined)} purpose="info" width="min(34rem, calc(100vw - 2rem))" padding={0} aria-label="Member details">{selected ? <><DialogHeader title="Member details" subtitle="Project membership identity." onOpenChange={(open) => !open && setSelected(undefined)} hasDivider /><dl className="grid gap-4 px-5 py-5 sm:grid-cols-[8rem_1fr]"><dt><Text color="secondary">Name</Text></dt><dd><Text wordBreak="break-all">{memberIdentityLabel(selected)}</Text></dd><dt><Text color="secondary">Email</Text></dt><dd><Text wordBreak="break-all">{selected.email}</Text></dd><dt><Text color="secondary">Role</Text></dt><dd><Text>{selected.role}</Text></dd><dt><Text color="secondary">Joined</Text></dt><dd><Text>{formatLocalDateTime(selected.createdAt)}</Text></dd><dt><Text color="secondary">Updated</Text></dt><dd><Text>{formatLocalDateTime(selected.updatedAt)}</Text></dd></dl></> : null}</Dialog>
  </PageLayout>;
}

function workspaceMemberLabel(member: WorkspaceMember) { return member.displayName || member.email || member.userId; }
function message(error: unknown) { return error instanceof ApiError ? error.message : "The member request could not be completed."; }
