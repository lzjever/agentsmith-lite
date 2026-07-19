"use client";

import { ChevronDown, FolderKanban, Globe, List, Menu } from "lucide-react";
import { useRouter } from "next/navigation";
import type { CurrentUser, Project, Workspace } from "../../lib/api/client";
import { orderProjectsForDisplay } from "../../lib/project-order";
import { ThemeToggle } from "../theme/ThemeToggle";
import { Button } from "../ui/button";
import {
  DropdownContent,
  DropdownItem,
  DropdownMenu,
} from "../ui/dropdown-menu";
import { Logo } from "./Logo";
import { UserMenu } from "./UserMenu";
import { NotificationBell } from "../notifications/NotificationBell";

export function Topbar({
  user,
  workspaces,
  workspace,
  project,
  profileReturnTo,
  onOpenNavigation,
}: {
  user: CurrentUser;
  workspaces: Workspace[];
  workspace?: Workspace | undefined;
  project?: Project | undefined;
  profileReturnTo?: string | undefined;
  onOpenNavigation: () => void;
}) {
  const router = useRouter();
  return (
    <header className="sticky top-0 z-30 flex h-11 max-w-full items-center gap-2 overflow-hidden border-b border-border/12 bg-background/94 px-2 sm:px-4 md:gap-3 md:px-5">
      <div className="flex shrink-0 items-center gap-1 sm:gap-2 [&_a>span:last-child]:hidden sm:[&_a>span:last-child]:inline">
        <Button
          variant="quiet"
          size="icon"
          className="md:hidden"
          aria-label="Open navigation"
          onClick={onOpenNavigation}
        >
          <Menu size={18} />
        </Button>
        <Logo />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {workspace ? (
          <WorkspaceSwitcher
            workspaces={workspaces}
            workspace={workspace}
            onSelect={(id) => router.push(`/workspaces/${id}`)}
          />
        ) : null}
        {workspace && project ? (
          <ProjectSwitcher
            workspace={workspace}
            project={project}
            onSelect={(id) =>
              router.push(`/workspaces/${workspace.id}/projects/${id}/overview`)
            }
            onViewAll={() => router.push(`/workspaces/${workspace.id}/projects`)}
          />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <NotificationBell {...(profileReturnTo ? { returnTo: profileReturnTo } : {})} />
        <ThemeToggle />
        <UserMenu
          user={user}
          {...(workspace ? { workspaceId: workspace.id } : {})}
          {...(profileReturnTo ? { returnTo: profileReturnTo } : {})}
        />
      </div>
    </header>
  );
}

function WorkspaceSwitcher({
  workspaces,
  workspace,
  onSelect,
}: {
  workspaces: Workspace[];
  workspace: Workspace;
  onSelect: (id: string) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="inline-flex h-8 min-w-0 max-w-full items-center gap-2 rounded-sm border border-transparent bg-transparent px-1.5 text-left text-secondary transition-[background-color,border-color,color] duration-150 hover:bg-surface-low/20 hover:text-foreground md:max-w-64">
        <Globe size={15} className="shrink-0 text-icon-default" />
        <span className="min-w-0 truncate text-[13px] text-foreground">
          {workspace.name}
        </span>
        <ChevronDown size={14} className="shrink-0 text-tertiary" />
      </DropdownMenu.Trigger>
      <DropdownContent align="start">
        {workspaces.map((item) => (
          <DropdownItem key={item.id} onSelect={() => onSelect(item.id)}>
            {item.name}
            {item.id === workspace.id ? (
              <span className="ml-auto text-xs text-tertiary">Current</span>
            ) : null}
          </DropdownItem>
        ))}
      </DropdownContent>
    </DropdownMenu.Root>
  );
}

export function ProjectSwitcher({
  workspace,
  project,
  mobile = false,
  onSelect,
  onViewAll,
}: {
  workspace: Workspace;
  project: Project;
  mobile?: boolean;
  onSelect: (projectId: string) => void;
  onViewAll?: (() => void) | undefined;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className={
          mobile
            ? "flex w-full min-w-0 items-center gap-2 rounded-sm border border-border/25 bg-transparent px-3 py-2 text-left text-secondary hover:bg-surface-low/30 hover:text-foreground"
            : "hidden h-8 min-w-0 max-w-64 items-center gap-2 rounded-sm border border-transparent bg-transparent px-1.5 text-left text-secondary transition-[background-color,border-color,color] duration-150 hover:bg-surface-low/20 hover:text-foreground md:inline-flex"
        }
      >
        <FolderKanban size={15} className="shrink-0 text-icon-default" />
        <span className="min-w-0 truncate text-[13px] text-foreground">
          {project.name}
        </span>
        <ChevronDown size={14} className="ml-auto shrink-0 text-tertiary" />
      </DropdownMenu.Trigger>
      <DropdownContent align="start">
        {orderProjectsForDisplay(workspace.projects).map((item) => (
          <DropdownItem key={item.id} onSelect={() => onSelect(item.id)}>
            {item.name}
            {item.id === project.id ? (
              <span className="ml-auto text-xs text-tertiary">Current</span>
            ) : null}
          </DropdownItem>
        ))}
        {onViewAll ? <><DropdownMenu.Separator className="my-1 h-px bg-subtle" /><DropdownItem className="gap-2" onSelect={onViewAll}><List size={15} />View all projects</DropdownItem></> : null}
      </DropdownContent>
    </DropdownMenu.Root>
  );
}
