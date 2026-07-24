"use client";

import { FolderKanban, Plus, Search } from "lucide-react";
import { Banner, Button, EmptyState, Spinner, Text, TextInput } from "@astryxdesign/core";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiClient, notifyDirectoryChanged, type Project, type ProjectDirectoryPage, type WorkspaceDetail, type WorkspaceMemberRole } from "../../lib/api/client";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { ProjectsTable } from "../projects/ProjectsTable";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";

type LoadState = "loading" | "ready" | "error";
type DirectoryAttempt = {
  cursor?: string;
  query: string;
  history: string[];
  includeWorkspace?: boolean;
};

export function WorkspaceProjectsEntryPage({ workspaceId }: { workspaceId: string }) {
  return <WorkspaceProjectsScope key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceProjectsScope({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const active = useRef(true);
  const request = useRef(0);
  const searchMounted = useRef(false);
  const hasContent = useRef(false);
  const workspaceRef = useRef<WorkspaceDetail|undefined>(undefined);
  const queryIntent = useRef("");
  const displayedScope = useRef<DirectoryAttempt>({ query: "", history: [] });
  const [workspace, setWorkspace] = useState<WorkspaceDetail>();
  const [page, setPage] = useState<ProjectDirectoryPage>({ items: [], nextCursor: null, total: 0 });
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [failedAttempt, setFailedAttempt] = useState<DirectoryAttempt>();
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState("");
  const [pinBusyId, setPinBusyId] = useState<string | null>(null);
  const [pinError, setPinError] = useState<{ projectId:string;pinned:boolean;message:string } | null>(null);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  async function load(attempt:DirectoryAttempt) {
    const loadRequest=++request.current;
    const preserveContent=hasContent.current;
    setFailedAttempt(undefined);
    if(preserveContent){setRefreshing(true);setRefreshError("");}
    else {setState("loading");setError("");}
    try {
      const [detail,projects]=await Promise.all([
        attempt.includeWorkspace||!workspaceRef.current?apiClient.workspace(workspaceId):Promise.resolve(workspaceRef.current),
        apiClient.workspaceProjects(workspaceId,{...(attempt.query?{q:attempt.query}:{}),...(attempt.cursor?{cursor:attempt.cursor}:{}),limit:20})
      ]);
      if(!active.current||loadRequest!==request.current)return;
      workspaceRef.current=detail;
      displayedScope.current=attempt;
      hasContent.current=true;
      setWorkspace(detail);
      setPage(projects);
      setCommittedQuery(attempt.query);
      setCursorHistory(attempt.history);
      setRefreshError("");
      setState("ready");
    } catch(reason) {
      if(!active.current||loadRequest!==request.current)return;
      const message=reason instanceof ApiError?reason.message:"Projects could not be loaded.";
      setFailedAttempt(attempt);
      if(hasContent.current){setRefreshError(message);setState("ready");}
      else {setError(message);setState("error");}
    } finally {
      if(active.current&&loadRequest===request.current)setRefreshing(false);
    }
  }

  useEffect(() => { void load({query:"",history:[],includeWorkspace:true}); }, [workspaceId]);
  useEffect(() => {
    if(!searchMounted.current){searchMounted.current=true;return;}
    const timer=window.setTimeout(()=>{
      const nextQuery=queryIntent.current;
      if(nextQuery===displayedScope.current.query&&displayedScope.current.cursor===undefined)return;
      void load({query:nextQuery,history:[]});
    },250);
    return()=>window.clearTimeout(timer);
  },[query]);

  function changeQuery(value:string) {
    queryIntent.current=value.trim();
    request.current+=1;
    setRefreshing(false);
    setRefreshError("");
    setFailedAttempt(undefined);
    setQuery(value);
  }

  function firstPageAttempt(includeWorkspace=false):DirectoryAttempt {
    return {query:queryIntent.current,history:[],...(includeWorkspace?{includeWorkspace:true}:{})};
  }

  function created(project:Project) {
    if(!active.current)return;
    setCreateOpen(false);
    router.push(`/workspaces/${workspaceId}/projects/${project.id}/overview`);
  }

  async function togglePin(projectId:string,desired?:boolean) {
    const project=page.items.find((item)=>item.id===projectId);
    if(!project||pinBusyId)return;
    const pinned=desired??!project.pinnedAt;
    setPinBusyId(projectId);
    setPinError(null);
    try {
      await apiClient.setProjectPinned(projectId,pinned);
      if(!active.current)return;
      notifyDirectoryChanged();
      await load(firstPageAttempt());
    } catch(reason) {
      if(!active.current)return;
      if(reason instanceof ApiError&&[403,404,409].includes(reason.status)){await load(firstPageAttempt(true));return;}
      setPinError({projectId,pinned,message:reason instanceof Error?reason.message:"Project pin could not be updated."});
    } finally {
      if(active.current)setPinBusyId(null);
    }
  }

  const canCreateProject=workspace?.capabilities.canCreateProject===true;
  const workspaceRecord=workspace?.workspace;
  return <PageLayout header={<PageHeader title="Projects" subtitle={workspaceRecord&&workspace?`${workspaceRecord.name} · Owner: ${workspace.owner.displayName||workspace.owner.email} · Your access: ${roleLabel(workspace.memberRole)}`:"Projects keep endpoints, members, files, and tasks together."} actions={canCreateProject?<Button label="New project" variant="primary" icon={<Plus size={16}/>} isDisabled={state!=="ready"} onClick={()=>{setCreateError("");setCreateOpen(true);}}/>:undefined}/>}>
    {state==="loading"?<div className="flex min-h-48 items-center justify-center"><Spinner label="Loading projects..."/></div>:null}
    {state==="error"?<WorkspaceProjectsError message={error} onRetry={()=>load(failedAttempt??{query:"",history:[],includeWorkspace:true})}/>:null}
    {state==="ready"&&createError?<Banner className="mb-4" status="error" title="Project could not be created" description={createError}/>:null}
    {state==="ready"&&pinError?<Banner className="mb-4" status="error" title="Project pin could not be updated" description={pinError.message} endContent={<Button label="Retry" variant="ghost" size="sm" onClick={()=>void togglePin(pinError.projectId,pinError.pinned)}/>} />:null}
    {state==="ready"&&refreshError?<Banner className="mb-4" status="error" title="Projects could not be refreshed" description={refreshError} endContent={<Button label="Try again" variant="secondary" size="sm" onClick={()=>{if(failedAttempt)void load(failedAttempt);}}/>}/>:null}
    {state==="ready"?<section className="space-y-4" aria-label="Project directory" aria-busy={refreshing}>
      <div className="flex min-h-10 items-center gap-3"><TextInput label="Search projects" isLabelHidden startIcon={<Search size={16}/>} value={query} onChange={changeQuery} className="max-w-sm" placeholder="Search projects" size="lg"/>{refreshing?<Spinner label="Updating projects..."/>:null}</div>
      {page.items.length>0?<ProjectsTable workspaceId={workspaceId} projects={page.items} pinBusyId={pinBusyId} onTogglePin={(projectId)=>void togglePin(projectId)}/>:committedQuery?<EmptyState icon={<FolderKanban/>} title="No projects match this search"/>:<ProjectsEmpty canCreateProject={canCreateProject} onCreate={()=>setCreateOpen(true)}/>}
      {page.items.length>0||cursorHistory.length>0?<div className="flex items-center justify-end gap-2"><Button label="Previous" variant="secondary" size="sm" isDisabled={refreshing||cursorHistory.length===0} onClick={()=>{const scope=displayedScope.current;const cursor=scope.history.at(-1);void load({...(cursor?{cursor}:{}),query:scope.query,history:scope.history.slice(0,-1)});}}/><Text type="supporting" color="secondary">Page {cursorHistory.length+1} · {page.total} projects</Text><Button label="Next" variant="secondary" size="sm" isDisabled={refreshing||!page.nextCursor} onClick={()=>{if(!page.nextCursor)return;const scope=displayedScope.current;void load({cursor:page.nextCursor,query:scope.query,history:[...scope.history,scope.cursor??""]});}}/></div>:null}
    </section>:null}
    {canCreateProject?<CreateProjectDialog workspaceId={workspaceId} open={createOpen} onOpenChange={setCreateOpen} onCreated={created} onAccessChanged={async(message)=>{setCreateError(message);await load(firstPageAttempt(true));}}/>:null}
  </PageLayout>;
}

function ProjectsEmpty({canCreateProject,onCreate}:{canCreateProject:boolean;onCreate:()=>void}) {
  return <EmptyState icon={<FolderKanban/>} title="No projects yet" description={canCreateProject?"Create a project to configure an endpoint, add members, and start work.":"No projects are available in this workspace."} {...(canCreateProject?{actions:<Button label="New project" variant="primary" onClick={onCreate}/>}:{})}/>;
}

function WorkspaceProjectsError({message,onRetry}:{message:string;onRetry:()=>void}) {
  return <Banner status="error" title="Projects unavailable" description={message} endContent={<span className="flex gap-2"><Button label="Try again" variant="secondary" onClick={()=>void onRetry()}/><Button href="/" label="Back to workspaces" variant="ghost"/></span>}/>;
}

function roleLabel(role:WorkspaceMemberRole):string { return role[0]!.toUpperCase()+role.slice(1); }
