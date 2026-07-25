"use client";

import { AppShell as AstryxAppShell, Button, Heading, MobileNav, Spinner, Text } from "@astryxdesign/core";
import { useParams, usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, apiClient, DIRECTORY_CHANGED_EVENT, IDENTITY_CHANGED_EVENT, oidcStartUrlForReturnTo, SESSION_EXPIRED_EVENT, type CurrentUser, type ProjectDetail, type ProjectDirectoryItem, type WorkspaceDetail, type WorkspaceDirectoryItem } from "../../lib/api/client";
import { DocumentTitle } from "../layout/DocumentTitle";
import { ThemeToggle } from "../theme/ThemeToggle";
import { Logo } from "./Logo";
import { ShellNavigation } from "./Sidebar";
import { ProjectSwitcher, Topbar } from "./Topbar";

type ShellProps={children:ReactNode;workspaceId?:string;projectId?:string};
type ShellState="loading"|"ready"|"login"|"error";
type DirectoryState="loading"|"ready"|"error";
type ExactReadIssue="unavailable"|"outage";

export function AppShell({children,workspaceId,projectId}:ShellProps) {
  const mounted=useRef(true);
  const identityRequest=useRef(0);
  const navigationRequest=useRef(0);
  const hasNavigation=useRef(false);
  const contentStart=useRef<HTMLDivElement>(null);
  const lastPathname=useRef<string|undefined>(undefined);
  const pathname=usePathname();
  const routeParams=useParams<{project?:string|string[]}>();
  const routedProjectId=Array.isArray(routeParams.project)?routeParams.project[0]:routeParams.project;
  const requestedProjectId=projectId??routedProjectId;
  const navigationScope=useRef({workspaceId,projectId:requestedProjectId});
  navigationScope.current={workspaceId,projectId:requestedProjectId};
  const [collapsed,setCollapsed]=useState(false);
  const [mobileNavigationOpen,setMobileNavigationOpen]=useState(false);
  const [status,setStatus]=useState<ShellState>("loading");
  const [directoryState,setDirectoryState]=useState<DirectoryState>("loading");
  const [user,setUser]=useState<CurrentUser>();
  const [workspace,setWorkspace]=useState<WorkspaceDetail>();
  const [project,setProject]=useState<ProjectDetail>();
  const [quickWorkspaces,setQuickWorkspaces]=useState<WorkspaceDirectoryItem[]>([]);
  const [quickProjects,setQuickProjects]=useState<ProjectDirectoryItem[]>([]);
  const [workspaceIssue,setWorkspaceIssue]=useState<ExactReadIssue>();
  const [projectIssue,setProjectIssue]=useState<ExactReadIssue>();

  async function loadIdentity(preservePage=false) {
    const request=++identityRequest.current;
    if(!preservePage)setStatus("loading");
    try {
      const identity=await apiClient.currentIdentity();
      if(!mounted.current||request!==identityRequest.current)return;
      setUser(identity.user);
      setStatus("ready");
    } catch(error) {
      if(!mounted.current||request!==identityRequest.current)return;
      if(error instanceof ApiError&&error.status===401)setStatus("login");
      else if(!preservePage)setStatus("error");
    }
  }

  async function loadNavigation(preservePage=hasNavigation.current) {
    const request=++navigationRequest.current;
    const scope=navigationScope.current;
    if(!preservePage)setDirectoryState("loading");
    const [workspacePage,workspaceResult,projectResult,projectPage]=await Promise.allSettled([
      apiClient.workspaces({limit:20}),
      scope.workspaceId?apiClient.workspace(scope.workspaceId):Promise.resolve(undefined),
      scope.projectId?apiClient.project(scope.projectId):Promise.resolve(undefined),
      scope.workspaceId?apiClient.workspaceProjects(scope.workspaceId,{limit:20}):Promise.resolve({items:[],nextCursor:null,total:0})
    ]);
    if(!mounted.current||request!==navigationRequest.current)return;
    if(workspacePage.status==="fulfilled")setQuickWorkspaces(workspacePage.value.items);
    else if(!preservePage)setQuickWorkspaces([]);
    const nextWorkspaceIssue=workspaceResult.status==="rejected"?exactReadIssue(workspaceResult.reason):undefined;
    const nextProjectIssue=projectResult.status==="rejected"?exactReadIssue(projectResult.reason):undefined;
    if(workspaceResult.status==="fulfilled"){setWorkspace(workspaceResult.value);setWorkspaceIssue(undefined);}
    else {setWorkspace(undefined);setWorkspaceIssue(nextWorkspaceIssue);}
    if(projectResult.status==="fulfilled"){setProject(projectResult.value);setProjectIssue(undefined);}
    else {setProject(undefined);setProjectIssue(nextProjectIssue);}
    if(projectPage.status==="fulfilled")setQuickProjects(projectPage.value.items);
    else if(!preservePage)setQuickProjects([]);
    hasNavigation.current=true;
    setDirectoryState(workspacePage.status==="rejected"||projectPage.status==="rejected"||nextWorkspaceIssue==="outage"||nextProjectIssue==="outage"?"error":"ready");
  }

  useEffect(()=>{
    mounted.current=true;
    const expireSession=()=>{identityRequest.current+=1;navigationRequest.current+=1;setUser(undefined);setStatus("login");};
    const refreshDirectory=()=>{void loadNavigation(true);};
    const refreshIdentity=()=>{void loadIdentity(true);};
    window.addEventListener(SESSION_EXPIRED_EVENT,expireSession);
    window.addEventListener(DIRECTORY_CHANGED_EVENT,refreshDirectory);
    window.addEventListener(IDENTITY_CHANGED_EVENT,refreshIdentity);
    return()=>{mounted.current=false;window.removeEventListener(SESSION_EXPIRED_EVENT,expireSession);window.removeEventListener(DIRECTORY_CHANGED_EVENT,refreshDirectory);window.removeEventListener(IDENTITY_CHANGED_EVENT,refreshIdentity);};
  },[]);
  useEffect(()=>{void loadIdentity();setCollapsed(window.localStorage.getItem("agentsmith-sidebar-collapsed")==="1");},[]);
  useEffect(()=>{void loadNavigation(hasNavigation.current);},[workspaceId,requestedProjectId]);
  useEffect(()=>{const target=contentStart.current;if(!target)return;if(lastPathname.current&&lastPathname.current!==pathname)target.focus();lastPathname.current=pathname;},[pathname,status,directoryState]);

  function setNavigationCollapsed(next:boolean) {
    setCollapsed(()=>{window.localStorage.setItem("agentsmith-sidebar-collapsed",next?"1":"0");return next;});
  }

  if(status==="loading")return <ShellLoadingFrame/>;
  if(status==="login"){const returnTo=typeof window==="undefined"?pathname:`${window.location.pathname}${window.location.search}${window.location.hash}`;return <ShellStatePage title="Sign in to continue" detail="Use your configured identity provider to access projects." action={<Button label="Sign in" variant="primary" onClick={()=>window.location.assign(oidcStartUrlForReturnTo(returnTo))}/>}/>}
  if(status==="error")return <ShellStatePage title="Workspace unavailable" detail="The product API could not load your session." action={<Button label="Try again" variant="secondary" onClick={()=>void loadIdentity()}/>}/>;
  if(directoryState==="loading")return <ShellLoadingFrame/>;

  const workspaceRecord=workspace?.workspace;
  const projectRecord=project?.project;
  const mismatch=Boolean(workspaceRecord&&projectRecord&&projectRecord.workspaceId!==workspaceRecord.id);
  const contextError=workspaceId&&workspaceIssue==="unavailable"
    ?<ShellRecoveryState title="Workspace unavailable" detail="This workspace does not exist or you no longer have permission to access it." retry={loadNavigation}/>
    :workspaceId&&workspaceIssue==="outage"
      ?<ShellRecoveryState title="Workspace could not be loaded" detail="The product API could not load this workspace. Try again." retryLabel="Try again" retry={loadNavigation}/>
    :requestedProjectId&&projectIssue==="unavailable"
      ?<ShellRecoveryState title="Project unavailable" detail="This project does not exist or you no longer have permission to access it." {...(workspaceRecord?{projectsHref:`/workspaces/${workspaceRecord.id}/projects`}:{})} retry={loadNavigation}/>
      :requestedProjectId&&projectIssue==="outage"
        ?<ShellRecoveryState title="Project could not be loaded" detail="The product API could not load this project. Try again." retryLabel="Try again" {...(workspaceRecord?{projectsHref:`/workspaces/${workspaceRecord.id}/projects`}:{})} retry={loadNavigation}/>
      :mismatch&&workspaceRecord&&project
        ?<ShellRecoveryState title="Project and workspace do not match" detail={`This project belongs to ${project.workspace.name}, not ${workspaceRecord.name}.`} projectHref={`/workspaces/${project.workspace.id}/projects/${projectRecord!.id}/overview`} retry={loadNavigation}/>
        :null;
  const profileReturnTo=typeof window==="undefined"?pathname:`${window.location.pathname}${window.location.search}${window.location.hash}`;
  const navigationProject=mismatch?undefined:projectRecord;
  return <AstryxAppShell
    variant="section"
    height="fill"
    topNav={<Topbar user={user!} workspaces={quickWorkspaces} projects={quickProjects} workspace={workspaceRecord} project={navigationProject} profileReturnTo={profileReturnTo} onOpenNavigation={()=>setMobileNavigationOpen(true)}/>}
    sideNav={<ShellNavigation workspace={workspaceRecord} project={navigationProject} pathname={pathname} collapsed={collapsed} onCollapsedChange={setNavigationCollapsed}/>}
    mobileNav={<MobileNav isOpen={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen} side="start" header="Navigation"><div className="flex min-h-full min-w-0 flex-col">{workspaceRecord&&navigationProject?<div className="shrink-0 min-w-0 border-b border-border p-3"><ProjectSwitcher projects={quickProjects} project={navigationProject} workspaceId={workspaceRecord.id} mobile onNavigate={()=>setMobileNavigationOpen(false)}/></div>:null}<div className="min-h-0 min-w-0 flex-1"><ShellNavigation workspace={workspaceRecord} project={navigationProject} pathname={pathname} onNavigate={()=>setMobileNavigationOpen(false)}/></div><ThemeToggle mobile/></div></MobileNav>}
  ><div ref={contentStart} tabIndex={-1} className="h-full min-h-0 outline-none">{directoryState==="error"?<DirectoryNotice onRetry={()=>loadNavigation(true)}/>:null}{contextError??children}</div></AstryxAppShell>;
}

function ShellLoadingFrame(){return <><DocumentTitle title="Loading"/><div className="min-h-screen bg-body"><header className="sticky top-0 flex h-[3.25rem] items-center border-b border-border bg-surface px-4 md:px-5"><Logo linked={false}/></header><div className="flex min-h-[calc(100vh-3.25rem)]"><aside className="hidden w-60 border-r border-border bg-muted md:block" aria-hidden="true"/><main className="grid min-w-0 flex-1 place-items-center"><Heading level={1} className="sr-only">Loading AgentSmith</Heading><Spinner label="Loading workspace..."/></main></div></div></>}
function ShellStatePage({title,detail,action}:{title:string;detail?:string;action?:ReactNode}){return <><DocumentTitle title={title}/><main className="grid min-h-screen place-items-center bg-body px-6"><section className="max-w-md text-center"><Logo linked={false} className="justify-center"/><Heading level={1} className="mt-5">{title}</Heading>{detail?<Text as="p" display="block" color="secondary" className="mt-3">{detail}</Text>:null}{action?<div className="mt-6">{action}</div>:null}</section></main></>}
function DirectoryNotice({onRetry}:{onRetry:()=>Promise<void>}){return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted px-4 py-2" role="status"><Text color="secondary">Workspace navigation is unavailable. This page may still be used.</Text><Button label="Retry navigation" size="sm" variant="ghost" onClick={()=>void onRetry()}/></div>}
function ShellRecoveryState({title,detail,projectsHref,projectHref,retryLabel="Check access again",retry}:{title:string;detail:string;projectsHref?:string;projectHref?:string;retryLabel?:string;retry:()=>Promise<void>}){return <><DocumentTitle title={title}/><section className="grid min-h-[calc(100vh-3.25rem)] place-items-center px-6"><div className="max-w-lg text-center"><Heading level={1}>{title}</Heading><Text as="p" display="block" color="secondary" className="mt-3">{detail}</Text><div className="mt-6 flex flex-wrap justify-center gap-2">{projectHref?<Button label="Open project" variant="primary" href={projectHref}/>:null}{projectsHref?<Button label="View all projects" variant="secondary" href={projectsHref}/>:null}<Button label="Back to workspaces" variant="secondary" href="/"/><Button label={retryLabel} variant="ghost" onClick={()=>void retry()}/></div></div></section></>}

function exactReadIssue(reason:unknown):ExactReadIssue {
  return reason instanceof ApiError&&(reason.status===403||reason.status===404)?"unavailable":"outage";
}
