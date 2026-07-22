"use client";

import { Badge, Button, IconButton, Selector, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core";
import { Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { MemberRole, ProjectMember } from "../../lib/api/client";
import { memberIdentityLabel, memberRoleLabel } from "./members-page-utils";

const editableRoles: Exclude<MemberRole, "owner">[] = ["admin", "member", "viewer"];

export function MembersTable({ members, canManage, busyUserId, roleError, onDismissRoleError, onChangeRole, onRemove, onView }: { members: ProjectMember[]; canManage: boolean; busyUserId: string | undefined; roleError: { userId: string; message: string } | undefined; onDismissRoleError: () => void; onChangeRole: (member: ProjectMember, role: Exclude<MemberRole, "owner">) => void; onRemove: (member: ProjectMember) => void; onView: (member: ProjectMember) => void }) {
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(members.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = useMemo(() => members.slice((currentPage - 1) * pageSize, currentPage * pageSize), [currentPage, members]);
  const mutationBusy = busyUserId !== undefined;

  return <section aria-label="Project members" className="space-y-3">
    <div className="hidden md:block">
      <Table aria-label="Project members" density="balanced" dividers="rows" verticalAlign="top">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Member</TableHeaderCell>
            <TableHeaderCell>Access</TableHeaderCell>
            <TableHeaderCell>Joined</TableHeaderCell>
            <TableHeaderCell>Actions</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((member) => <TableRow key={member.userId}>
            <TableCell><MemberIdentity member={member} /></TableCell>
            <TableCell><MemberRoleCell member={member} canManage={canManage} busy={mutationBusy} roleError={roleError} onDismissRoleError={onDismissRoleError} onChangeRole={onChangeRole} /></TableCell>
            <TableCell><span className="text-sm text-secondary">{formatJoined(member.createdAt)}</span></TableCell>
            <TableCell><MemberActions member={member} canManage={canManage} busy={mutationBusy} onRemove={onRemove} onView={onView} /></TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </div>
    <div className="divide-y divide-subtle rounded-md border border-subtle md:hidden">
      {visible.map((member) => <article className="space-y-4 p-4" key={member.userId}>
        <MemberIdentity member={member} />
        <div className="grid grid-cols-2 gap-4">
          <div><p className="type-caption text-tertiary">Access</p><div className="mt-1"><MemberRoleControl member={member} canManage={canManage} busy={mutationBusy} onChangeRole={onChangeRole} /></div></div>
          <div><p className="type-caption text-tertiary">Joined</p><p className="mt-1 text-sm text-secondary">{formatJoined(member.createdAt)}</p></div>
        </div>
        {roleError?.userId === member.userId ? <InlineError message={roleError.message} onDismiss={onDismissRoleError} /> : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-subtle pt-3"><MemberActions member={member} canManage={canManage} busy={mutationBusy} onRemove={onRemove} onView={onView} /></div>
      </article>)}
    </div>
    {pageCount > 1 ? <div className="flex items-center justify-end gap-2"><Button label="Previous" variant="secondary" size="md" isDisabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} /><span className="text-xs text-tertiary">Page {currentPage} of {pageCount}</span><Button label="Next" variant="secondary" size="md" isDisabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)} /></div> : null}
  </section>;
}

function MemberIdentity({ member }: { member: ProjectMember }) { return <div className="grid gap-1"><strong className="break-all font-medium text-foreground">{memberIdentityLabel(member)}</strong>{member.displayName ? <span className="text-xs text-secondary">{member.email}</span> : null}</div>; }

function MemberRoleCell({ member, canManage, busy, roleError, onDismissRoleError, onChangeRole }: { member: ProjectMember; canManage: boolean; busy: boolean; roleError: { userId: string; message: string } | undefined; onDismissRoleError: () => void; onChangeRole: (member: ProjectMember, role: Exclude<MemberRole, "owner">) => void }) {
  return <><MemberRoleControl member={member} canManage={canManage} busy={busy} onChangeRole={onChangeRole} />{roleError?.userId === member.userId ? <InlineError message={roleError.message} onDismiss={onDismissRoleError} /> : null}</>;
}

function MemberRoleControl({ member, canManage, busy, onChangeRole }: { member: ProjectMember; canManage: boolean; busy: boolean; onChangeRole: (member: ProjectMember, role: Exclude<MemberRole, "owner">) => void }) {
  return canManage && member.role !== "owner" ? <Selector label={`Role for ${memberIdentityLabel(member)}`} isLabelHidden size="lg" width={128} options={editableRoles.map((role) => ({ value: role, label: memberRoleLabel(role) }))} value={member.role} isDisabled={busy} onChange={(value) => onChangeRole(member, value as Exclude<MemberRole, "owner">)} /> : <Badge variant="neutral" label={memberRoleLabel(member.role)} />;
}

function MemberActions({ member, canManage, busy, onRemove, onView }: { member: ProjectMember; canManage: boolean; busy: boolean; onRemove: (member: ProjectMember) => void; onView: (member: ProjectMember) => void }) {
  return <div className="flex flex-wrap items-center justify-end gap-2"><Button label="View details" variant="ghost" size="md" onClick={() => onView(member)} />{canManage && member.role !== "owner" ? <IconButton label={`Remove ${memberIdentityLabel(member)}`} variant="ghost" size="lg" className="text-error" title="Remove member" isDisabled={busy} onClick={() => onRemove(member)} icon={<Trash2 size={15} />} /> : null}</div>;
}

function InlineError({ message, onDismiss }: { message: string; onDismiss: () => void }) { return <div className="mt-2 flex items-center justify-between gap-2 text-sm text-error" role="alert"><span>{message}</span><IconButton label="Dismiss role error" variant="ghost" size="lg" onClick={onDismiss} icon={<X size={15} />} /></div>; }

function formatJoined(value: string): string { return new Date(value).toLocaleDateString(); }
