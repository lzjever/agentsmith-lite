"use client";

import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowRight, FolderKanban, Pin, PinOff, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Project } from "../../lib/api/client";
import { DataTable } from "../ui/data-table";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";

const columns = createColumnHelper<Project>();

export function ProjectsTable({
  workspaceId,
  projects,
  pinnedProjectIds = new Set<string>(),
  onTogglePin,
}: {
  workspaceId: string;
  projects: Project[];
  pinnedProjectIds?: Set<string>;
  onTogglePin?: (projectId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const filtered = useMemo(
    () =>
      projects
        .filter((project) =>
          project.name.toLowerCase().includes(query.trim().toLowerCase()),
        )
        .sort(
          (left, right) =>
            Number(pinnedProjectIds.has(right.id)) -
              Number(pinnedProjectIds.has(left.id)) ||
            left.name.localeCompare(right.name),
        ),
    [projects, query, pinnedProjectIds],
  );
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const table = useReactTable({
    data: visible,
    columns: [
      columns.accessor("name", {
        header: "Project",
        cell: ({ row }) => (
          <Link
            href={projectHref(workspaceId, row.original.id)}
            className="flex items-center gap-3 text-foreground no-underline"
          >
            <span className="grid size-8 place-items-center rounded-sm bg-surface-high text-icon-default">
              <FolderKanban size={16} />
            </span>
            <span className="font-medium">{row.original.name}</span>
          </Link>
        ),
      }),
      columns.accessor("taskConcurrencyLimit", {
        header: "Task concurrency",
        cell: (info) => info.getValue(),
      }),
      columns.display({
        id: "lifecycleStatus",
        header: "Status",
        cell: ({ row }) => <ProjectLifecycleStatus project={row.original} />,
      }),
      columns.accessor("createdAt", {
        header: "Created",
        cell: (info) => formatDate(info.getValue()),
      }),
      ...(onTogglePin
        ? [
            columns.display({
              id: "pin",
              header: "",
              cell: ({ row }) => (
                <ButtonPin
                  project={row.original}
                  pinned={pinnedProjectIds.has(row.original.id)}
                  onTogglePin={onTogglePin}
                />
              ),
            }),
          ]
        : []),
      columns.display({
        id: "open",
        header: "",
        cell: ({ row }) => (
          <Link
            href={projectHref(workspaceId, row.original.id)}
            className="inline-flex items-center gap-1 text-sm text-secondary no-underline hover:text-foreground"
          >
            Open
            <ArrowRight size={15} />
          </Link>
        ),
      }),
    ],
    getCoreRowModel: getCoreRowModel(),
  });
  function changeQuery(value: string) {
    setQuery(value);
    setPage(1);
  }
  return (
    <section aria-label="Projects" className="space-y-4">
      <label className="relative block max-w-sm">
        <span className="sr-only">Search projects</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary" />
        <Input
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
          className="h-9 pl-9"
          placeholder="Search projects"
        />
      </label>
      <div className="hidden md:block">
        <DataTable table={table} testId="projects-table" />
      </div>
      <div className="divide-y divide-subtle border-y border-subtle md:hidden">
        {visible.map((project) => (
          <ProjectCard
            workspaceId={workspaceId}
            project={project}
            key={project.id}
            pinned={pinnedProjectIds.has(project.id)}
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
  onTogglePin,
}: {
  workspaceId: string;
  project: Project;
  pinned?: boolean;
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
          onTogglePin={onTogglePin}
        />
      ) : null}
    </div>
  );
}
function ProjectLifecycleStatus({ project }: { project: Project }) {
  const status = project.lifecycleStatus ?? "active";
  const variant = status === "active" ? "success" : status === "archived" ? "secondary" : "warning";
  return <Badge variant={variant}>{status[0]!.toUpperCase() + status.slice(1)}</Badge>;
}
function ButtonPin({
  project,
  pinned,
  onTogglePin,
}: {
  project: Project;
  pinned: boolean;
  onTogglePin: (projectId: string) => void;
}) {
  return (
    <button
      type="button"
      className="grid size-8 shrink-0 place-items-center text-secondary hover:text-foreground"
      aria-label={`${pinned ? "Unpin" : "Pin"} ${project.name}`}
      title={pinned ? "Unpin project" : "Pin project"}
      onClick={() => onTogglePin(project.id)}
    >
      {pinned ? <PinOff size={16} /> : <Pin size={16} />}
    </button>
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
      <button
        type="button"
        className="rounded-md border border-subtle bg-surface px-2 py-1 text-xs text-primary disabled:opacity-50"
        disabled={page === 1}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </button>
      <span className="text-xs text-tertiary">
        Page {page} of {pageCount}
      </span>
      <button
        type="button"
        className="rounded-md border border-subtle bg-surface px-2 py-1 text-xs text-primary disabled:opacity-50"
        disabled={page === pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </button>
    </div>
  );
}
export function projectHref(workspaceId: string, projectId: string): string {
  return `/workspaces/${workspaceId}/projects/${projectId}/overview`;
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}
