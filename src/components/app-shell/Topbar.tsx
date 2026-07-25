"use client";

import { FolderKanban, Globe, List } from "lucide-react";
import { IconButton, Selector, Text, TopNav as AstryxTopNav } from "@astryxdesign/core";
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
}: {
  user: CurrentUser;
  workspaces: WorkspaceDirectoryItem[];
  projects: ProjectDirectoryItem[];
  workspace?: Workspace | undefined;
  project?: Project | undefined;
  profileReturnTo?: string | undefined;
}) {
  const router = useRouter();
  return (
    <AstryxTopNav
      label="Application controls"
      className="min-h-14 bg-surface px-3 sm:px-5 lg:px-6"
      heading={
      <div className="flex shrink-0 items-center">
        <Logo compactOnMobile />
      </div>
      }
      startContent={<div className="flex min-w-0 items-center gap-3">
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
            workspaceId={workspace.id}
          />
        ) : null}
      </div>
      }
      endContent={<div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <NotificationBell {...(profileReturnTo ? { returnTo: profileReturnTo } : {})} />
        <div className="hidden lg:block"><ThemeToggle /></div>
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

export function WorkspaceSwitcher({
  workspaces,
  workspace,
  onSelect,
  onViewAll,
  mobile = false,
  onNavigate,
}: {
  workspaces: WorkspaceDirectoryItem[];
  workspace: Workspace;
  onSelect: (id: string) => void;
  onViewAll: () => void;
  mobile?: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const options=dedupeOptions([{value:workspace.id,label:workspace.name},...workspaces.map((item)=>({value:item.id,label:item.name}))]);
  function select(id: string) {
    onSelect(id);
    onNavigate?.();
  }
  function viewAll() {
    onViewAll();
    onNavigate?.();
  }
  return (
    <div className={mobile ? "flex w-full min-w-0 items-end gap-2" : "flex min-w-0 items-center gap-2"}>
      <div className={mobile ? "min-w-0 flex-1" : "flex min-w-0 items-center gap-2"}>
        {!mobile ? <Text type="supporting" color="secondary" className="shrink-0">Workspace</Text> : null}
        <div className={mobile ? "min-w-0" : "w-40 min-w-0 xl:w-48"}><Selector
          label="Current workspace"
          isLabelHidden={!mobile}
          startIcon={<Globe size={15} />}
          options={options}
          value={workspace.id}
          onChange={select}
          size="lg"
          width="100%"
        /></div>
      </div>
      <IconButton label="View all workspaces" tooltip="View all workspaces" icon={<List size={15}/>} variant="ghost" size="lg" onClick={viewAll}/>
    </div>
  );
}

export function ProjectSwitcher({
  projects,
  project,
  workspaceId,
  mobile = false,
  onNavigate,
}: {
  projects: ProjectDirectoryItem[];
  project: Project;
  workspaceId: string;
  mobile?: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const router=useRouter();
  const options=dedupeOptions([{value:project.id,label:project.name},...projects.map((item)=>({value:item.id,label:item.name}))]);
  function navigate(href:string){router.push(href);onNavigate?.();}
  return (
    <div className={mobile ? "flex w-full min-w-0 items-end gap-2" : "flex min-w-0 items-center gap-2"}>
      <div className={mobile ? "min-w-0 flex-1" : "flex min-w-0 items-center gap-2"}>
        {!mobile ? <Text type="supporting" color="secondary" className="shrink-0">Project</Text> : null}
        <div className={mobile ? "min-w-0" : "w-40 min-w-0 xl:w-48"}>
          <Selector
            label="Current project"
            isLabelHidden={!mobile}
            startIcon={<FolderKanban size={15} />}
            options={options}
            value={project.id}
            onChange={(projectId)=>navigate(`/workspaces/${workspaceId}/projects/${projectId}/overview`)}
            size="lg"
            width="100%"
          />
        </div>
      </div>
      <IconButton label="View all projects" tooltip="View all projects" icon={<List size={15} />} variant="ghost" size="lg" onClick={()=>navigate(`/workspaces/${workspaceId}/projects`)} />
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
