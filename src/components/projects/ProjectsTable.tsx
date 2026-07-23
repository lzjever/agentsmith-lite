"use client";

import { ArrowRight, FolderKanban, Pin, PinOff, Search } from "lucide-react";
import {
  Badge,
  Button,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TextInput,
} from "@astryxdesign/core";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Project } from "../../lib/api/client";
import { formatLocalDate as formatDate } from "../../lib/format/date";
import { orderProjectsForDisplay } from "../../lib/project-order";
export function ProjectsTable({
  workspaceId,
  projects,
  pinBusyId,
  onTogglePin,
}: {
  workspaceId: string;
  projects: Project[];
  pinBusyId?: string | null;
  onTogglePin?: (projectId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const filtered = useMemo(
    () =>
      orderProjectsForDisplay(
        projects.filter((project) =>
          project.name.toLowerCase().includes(query.trim().toLowerCase()),
        ),
      ),
    [projects, query],
  );
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = useMemo(
    () =>
      filtered.slice(
        (currentPage - 1) * pageSize,
        currentPage * pageSize,
      ),
    [currentPage, filtered],
  );
  function changeQuery(value: string) {
    setQuery(value);
    setPage(1);
  }
  return (
    <section aria-label="Projects" className="space-y-4">
      <TextInput
        label="Search projects"
        isLabelHidden
        startIcon={<Search size={16} />}
        value={query}
        onChange={changeQuery}
        className="max-w-sm"
        placeholder="Search projects"
        size="lg"
      />
      <div className="hidden md:block">
        <Table
          aria-label="Projects"
          data-testid="projects-table"
          density="balanced"
          dividers="rows"
          hasHover
        >
          <TableHeader>
            <TableRow isHeaderRow>
              <TableHeaderCell>Project</TableHeaderCell>
              <TableHeaderCell>Task concurrency</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Created</TableHeaderCell>
              {onTogglePin ? <TableHeaderCell /> : null}
              <TableHeaderCell />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((project) => (
              <TableRow
                data-row-id={project.id}
                data-testid="projects-table__row"
                key={project.id}
              >
                <TableCell>
                  <Link
                    href={projectHref(workspaceId, project.id)}
                    className="flex items-center gap-3 text-foreground no-underline"
                  >
                    <span className="grid size-8 place-items-center rounded-sm bg-surface-high text-icon-default">
                      <FolderKanban size={16} />
                    </span>
                    <span className="font-medium">{project.name}</span>
                  </Link>
                </TableCell>
                <TableCell>{project.taskConcurrencyLimit}</TableCell>
                <TableCell>
                  <ProjectLifecycleStatus project={project} />
                </TableCell>
                <TableCell>{formatDate(project.createdAt)}</TableCell>
                {onTogglePin ? (
                  <TableCell>
                    <ButtonPin
                      project={project}
                      pinned={Boolean(project.pinnedAt)}
                      busy={pinBusyId !== null && pinBusyId !== undefined}
                      onTogglePin={onTogglePin}
                    />
                  </TableCell>
                ) : null}
                <TableCell>
                  <Link
                    href={projectHref(workspaceId, project.id)}
                    className="inline-flex items-center gap-1 text-sm text-secondary no-underline hover:text-foreground"
                  >
                    Open
                    <ArrowRight size={15} />
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="divide-y divide-subtle border-y border-subtle md:hidden">
        {visible.map((project) => (
          <ProjectCard
            workspaceId={workspaceId}
            project={project}
            key={project.id}
            pinned={Boolean(project.pinnedAt)}
            busy={pinBusyId !== null && pinBusyId !== undefined}
            {...(onTogglePin ? { onTogglePin } : {})}
          />
        ))}
      </div>
      {filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-secondary">
          No projects match this search.
        </p>
      ) : null}
      {pageCount > 1 ? (
        <Pagination
          page={currentPage}
          pageCount={pageCount}
          onPageChange={setPage}
        />
      ) : null}
    </section>
  );
}

export function ProjectCard({
  workspaceId,
  project,
  pinned = false,
  busy = false,
  onTogglePin,
}: {
  workspaceId: string;
  project: Project;
  pinned?: boolean;
  busy?: boolean;
  onTogglePin?: (projectId: string) => void;
}) {
  return (
    <div className="group flex items-center justify-between gap-3 px-2 py-4">
      <Link
        href={projectHref(workspaceId, project.id)}
        className="flex min-w-0 flex-1 items-center justify-between gap-4 text-foreground no-underline transition-colors hover:bg-surface-low"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-sm bg-surface-high text-icon-default">
            <FolderKanban size={17} />
          </span>
          <span className="min-w-0">
            <strong className="block truncate font-medium">
              {project.name}
            </strong>
            <small className="mt-1 block text-secondary">
              Task concurrency: {project.taskConcurrencyLimit}
            </small>
            <span className="mt-2 block"><ProjectLifecycleStatus project={project} /></span>
          </span>
        </span>
        <ArrowRight
          size={16}
          className="shrink-0 text-icon-default transition-transform group-hover:translate-x-0.5"
        />
      </Link>
      {onTogglePin ? (
        <ButtonPin
          project={project}
          pinned={pinned}
          busy={busy}
          onTogglePin={onTogglePin}
        />
      ) : null}
    </div>
  );
}
function ProjectLifecycleStatus({ project }: { project: Project }) {
  const status = project.lifecycleStatus ?? "active";
  const variant = status === "active" ? "success" : status === "archived" ? "secondary" : "warning";
  return <Badge variant={variant === "secondary" ? "neutral" : variant} label={status[0]!.toUpperCase() + status.slice(1)} />;
}
function ButtonPin({
  project,
  pinned,
  busy,
  onTogglePin,
}: {
  project: Project;
  pinned: boolean;
  busy: boolean;
  onTogglePin: (projectId: string) => void;
}) {
  return (
    <IconButton
      label={`${pinned ? "Unpin" : "Pin"} ${project.name}`}
      variant="ghost"
      size="md"
      className="shrink-0 text-secondary hover:text-foreground"
      isDisabled={busy}
      icon={pinned ? <PinOff size={16} /> : <Pin size={16} />}
      onClick={() => onTogglePin(project.id)}
    />
  );
}
function Pagination({
  page,
  pageCount,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        label="Previous"
        variant="secondary"
        size="sm"
        isDisabled={page === 1}
        onClick={() => onPageChange(page - 1)}
      />
      <span className="text-xs text-tertiary">
        Page {page} of {pageCount}
      </span>
      <Button
        label="Next"
        variant="secondary"
        size="sm"
        isDisabled={page === pageCount}
        onClick={() => onPageChange(page + 1)}
      />
    </div>
  );
}
export function projectHref(workspaceId: string, projectId: string): string {
  return `/workspaces/${workspaceId}/projects/${projectId}/overview`;
}
