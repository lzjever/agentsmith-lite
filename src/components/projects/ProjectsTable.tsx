"use client";

import { ArrowRight, FolderKanban, Pin, PinOff } from "lucide-react";
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
  Text,
} from "@astryxdesign/core";
import Link from "next/link";
import type { Project } from "../../lib/api/client";
import { formatLocalDate as formatDate } from "../../lib/format/date";
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
  return (
    <section aria-label="Projects">
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
            {projects.map((project) => (
              <TableRow
                data-row-id={project.id}
                data-testid="projects-table__row"
                key={project.id}
              >
                <TableCell>
                  <Link
                    href={projectHref(workspaceId, project.id)}
                    className="flex items-center gap-3 text-primary no-underline"
                  >
                    <span className="grid size-8 place-items-center rounded-sm bg-muted text-icon-secondary">
                      <FolderKanban size={16} />
                    </span>
                    <Text weight="medium">{project.name}</Text>
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
                    className="inline-flex items-center gap-1 no-underline hover:text-primary"
                  >
                    <Text type="supporting" color="secondary">Open</Text>
                    <ArrowRight size={15} />
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="divide-y divide-border border-y border-border md:hidden">
        {projects.map((project) => (
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
        className="flex min-w-0 flex-1 items-center justify-between gap-4 text-primary no-underline hover:bg-overlay-hover"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-sm bg-muted text-icon-secondary">
            <FolderKanban size={17} />
          </span>
          <span className="min-w-0">
            <Text weight="medium" display="block" maxLines={1}>{project.name}</Text>
            <Text type="supporting" color="secondary" display="block" className="mt-1">Task concurrency: {project.taskConcurrencyLimit}</Text>
            <span className="mt-2 block"><ProjectLifecycleStatus project={project} /></span>
          </span>
        </span>
        <ArrowRight
          size={16}
          className="shrink-0 text-icon-secondary group-hover:translate-x-0.5"
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
      tooltip={`${pinned ? "Unpin" : "Pin"} ${project.name}`}
      variant="ghost"
      size="md"
      className="shrink-0 text-secondary hover:text-primary"
      isDisabled={busy}
      icon={pinned ? <PinOff size={16} /> : <Pin size={16} />}
      onClick={() => onTogglePin(project.id)}
    />
  );
}
export function projectHref(workspaceId: string, projectId: string): string {
  return `/workspaces/${workspaceId}/projects/${projectId}/overview`;
}
