"use client";

import { FolderKanban, Globe, List, Menu } from "lucide-react";
import { IconButton, Selector, TopNav as AstryxTopNav } from "@astryxdesign/core";
import { useRouter } from "next/navigation";
import type { CurrentUser, Project, ProjectDirectoryItem, Workspace, WorkspaceDirectoryItem } from "../../lib/api/client";
import { ThemeToggle } from "../theme/ThemeToggle";
import { Logo } from "./Logo";
import { UserMenu } from "./UserMenu";
import { NotificationBell } from "../notifications/NotificationBell";

export function Topbar({
  user,
  workspaces,
  projects,
  workspace,
  project,
  profileReturnTo,
  onOpenNavigation,
}: {
  user: CurrentUser;
  workspaces: WorkspaceDirectoryItem[];
  projects: ProjectDirectoryItem[];
  workspace?: Workspace | undefined;
  project?: Project | undefined;
  profileReturnTo?: string | undefined;
  onOpenNavigation: () => void;
}) {
  const router = useRouter();
  return (
    <AstryxTopNav
      label="Application controls"
      className="min-h-[3.25rem] border-b border-border bg-surface px-2 shadow-sm sm:px-4 md:px-5"
      heading={
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <IconButton
          label="Open navigation"
          tooltip="Open navigation"
          icon={<Menu size={18} />}
          variant="ghost"
          className="md:hidden"
          onClick={onOpenNavigation}
        />
        <Logo compactOnMobile />
      </div>
      }
      startContent={<div className="flex min-w-0 items-center gap-1 overflow-hidden before:mx-1 before:h-5 before:w-px before:bg-border md:gap-2">
        {workspace ? (
          <WorkspaceSwitcher
            workspaces={workspaces}
            workspace={workspace}
            onSelect={(id) => router.push(`/workspaces/${id}`)}
            onViewAll={() => router.push("/")}
          />
        ) : null}
        {workspace && project ? (
          <ProjectSwitcher
            projects={projects}
            project={project}
            onSelect={(id) =>
              router.push(`/workspaces/${workspace.id}/projects/${id}/overview`)
            }
            onViewAll={() => router.push(`/workspaces/${workspace.id}/projects`)}
          />
        ) : null}
      </div>
      }
      endContent={<div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <NotificationBell {...(profileReturnTo ? { returnTo: profileReturnTo } : {})} />
        <ThemeToggle />
        <UserMenu
          user={user}
          {...(workspace ? { workspaceId: workspace.id } : {})}
          {...(profileReturnTo ? { returnTo: profileReturnTo } : {})}
        />
      </div>
      }
    />
  );
}

function WorkspaceSwitcher({
  workspaces,
  workspace,
  onSelect,
  onViewAll,
}: {
  workspaces: WorkspaceDirectoryItem[];
  workspace: Workspace;
  onSelect: (id: string) => void;
  onViewAll: () => void;
}) {
  const options=dedupeOptions([{value:workspace.id,label:workspace.name},...workspaces.map((item)=>({value:item.id,label:item.name}))]);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="min-w-0 w-40 sm:w-56 md:w-64"><Selector
          label="Current workspace"
          isLabelHidden
          startIcon={<Globe size={15} />}
          options={options}
          value={workspace.id}
          onChange={onSelect}
          size="lg"
          width="100%"
        /></div>
      <IconButton label="View all workspaces" tooltip="View all workspaces" icon={<List size={15}/>} variant="ghost" size="lg" onClick={onViewAll}/>
    </div>
  );
}

export function ProjectSwitcher({
  projects,
  project,
  mobile = false,
  onSelect,
  onViewAll,
}: {
  projects: ProjectDirectoryItem[];
  project: Project;
  mobile?: boolean;
  onSelect: (projectId: string) => void;
  onViewAll?: (() => void) | undefined;
}) {
  const options=dedupeOptions([{value:project.id,label:project.name},...projects.map((item)=>({value:item.id,label:item.name}))]);
  return (
    <div className={mobile ? "flex w-full min-w-0 items-center gap-1" : "hidden min-w-0 items-center gap-1 md:flex"}>
      <div className={mobile ? "min-w-0 flex-1" : "min-w-0 w-64"}>
        <Selector
          label="Current project"
          isLabelHidden
          startIcon={<FolderKanban size={15} />}
          options={options}
          value={project.id}
          onChange={onSelect}
          size="lg"
          width="100%"
        />
      </div>
      {onViewAll ? <IconButton label="View all projects" tooltip="View all projects" icon={<List size={15} />} variant="ghost" size="lg" onClick={onViewAll} /> : null}
    </div>
  );
}

function dedupeOptions(options:Array<{value:string;label:string}>):Array<{value:string;label:string}> {
  const seen=new Set<string>();
  const unique:Array<{value:string;label:string}>=[];
  for(const option of options) {
    if(seen.has(option.value))continue;
    seen.add(option.value);
    unique.push(option);
  }
  return unique;
}
