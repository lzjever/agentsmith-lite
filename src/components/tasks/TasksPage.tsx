"use client";

import { Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiClient, isReadOnlyMutationError, type Endpoint, type ProjectCapabilities, type ProjectFile, type TaskListPage, type TaskListQuery } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { TaskCreateDialog } from "./TaskCreateDialog";
import { TaskList } from "./TaskList";
import { taskCompatibleEndpoints, taskEndpointGuidance, taskNeedsRefresh } from "./task-ui";
import { useTaskMutationKeys } from "./task-mutation-key";

const emptyPage: TaskListPage = { items: [], nextCursor: null, total: 0 };
const initialQuery: TaskListQuery = { archived: "exclude", sort: "updated_at", direction: "desc", limit: 25 };
type DependencyState = "loading" | "ready" | "error";

export function TasksPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const router = useRouter();
  return <TasksPageContent workspaceId={workspaceId} projectId={projectId} navigate={(path) => router.push(path)} />;
}

type TasksPageContentProps = { workspaceId: string; projectId: string; navigate: (path: string) => void };

export function TasksPageContent(props: TasksPageContentProps) {
  return <ProjectTasksPageContent key={`${props.workspaceId}:${props.projectId}`} {...props} />;
}

function ProjectTasksPageContent({ workspaceId, projectId, navigate }: TasksPageContentProps) {
  const mutationKeys = useTaskMutationKeys();
  const active = useRef(true);
  const [page, setPage] = useState<TaskListPage>(emptyPage);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [endpointsState, setEndpointsState] = useState<DependencyState>("loading");
  const [capabilitiesState, setCapabilitiesState] = useState<DependencyState>("loading");
  const [endpointsError, setEndpointsError] = useState("");
  const [capabilitiesError, setCapabilitiesError] = useState("");
  const [query, setQuery] = useState<TaskListQuery>(initialQuery);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const loadVersion = useRef(0);
  const endpointsLoadVersion = useRef(0);
  const capabilitiesLoadVersion = useRef(0);
  const basePath = `/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const cursor = cursors[pageIndex];

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const loadEndpoints = useCallback(async () => {
    const endpointsVersion = ++endpointsLoadVersion.current;
    setEndpointsState("loading");
    setEndpointsError("");
    try {
      const available = await apiClient.endpoints(projectId);
      if (!active.current || endpointsVersion !== endpointsLoadVersion.current) return;
      setEndpoints(available);
      setEndpointsState("ready");
    } catch (reason) {
      if (!active.current || endpointsVersion !== endpointsLoadVersion.current) return;
      setEndpoints([]);
      setEndpointsError(message(reason));
      setEndpointsState("error");
    }
  }, [projectId]);

  const loadCapabilities = useCallback(() => {
    const capabilitiesVersion = ++capabilitiesLoadVersion.current;
    setCapabilitiesState("loading");
    setCapabilitiesError("");
    void apiClient.projectCapabilities(projectId).then((projected) => {
      if (!active.current || capabilitiesVersion !== capabilitiesLoadVersion.current) return;
      setCapabilities(projected);
      setCapabilitiesState("ready");
    }).catch((reason) => {
      if (!active.current || capabilitiesVersion !== capabilitiesLoadVersion.current) return;
      setCapabilities(undefined);
      setCapabilitiesError(message(reason));
      setCapabilitiesState("error");
    });
  }, [projectId]);

  const loadCreateDependencies = useCallback(() => {
    void loadEndpoints();
    loadCapabilities();
  }, [loadCapabilities, loadEndpoints]);

  const load = useCallback(async (quiet = false) => {
    const version = ++loadVersion.current;
    if (!quiet) setState("loading");
    try {
      const listed = await apiClient.tasks(projectId, { ...query, ...(cursor ? { cursor } : {}) });
      if (!active.current || version !== loadVersion.current) return;
      setPage(listed);
      setError("");
      setState("ready");
    } catch (reason) {
      if (!active.current || version !== loadVersion.current) return;
      setError(message(reason));
      setState("error");
    }
  }, [cursor, projectId, query]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { loadCreateDependencies(); }, [loadCreateDependencies]);
  useEffect(() => {
    if (!dialogOpen) return;
    let active = true;
    setProjectFiles([]);
    setProjectFilesLoading(true);
    void apiClient.files(projectId).then((files) => {
      if (active) setProjectFiles(files.entries);
    }).catch(() => {
      if (active) {
        setProjectFiles([]);
        toast.error("Project files could not be loaded.");
      }
    }).finally(() => {
      if (active) setProjectFilesLoading(false);
    });
    return () => { active = false; };
  }, [dialogOpen, projectId]);
  useEffect(() => {
    if (!page.items.some(taskNeedsRefresh)) return;
    const timer = window.setInterval(() => void load(true), 5_000);
    return () => window.clearInterval(timer);
  }, [load, page.items]);

  function changeQuery(next: TaskListQuery) {
    setQuery({ ...next, cursor: undefined, limit: next.limit ?? 25 });
    setCursors([undefined]);
    setPageIndex(0);
  }

  function nextPage() {
    if (!page.nextCursor) return;
    setCursors((current) => [...current.slice(0, pageIndex + 1), page.nextCursor ?? undefined]);
    setPageIndex((value) => value + 1);
  }

  async function createTask(input: { title: string; prompt: string; endpointId: string; inputPaths: string[] }) {
    setCreating(true);
    setError("");
    const identity = JSON.stringify(input);
    try {
      const title = input.title.trim();
      const task = await apiClient.createTask(projectId, { prompt: input.prompt, endpointId: input.endpointId, ...(title ? { title } : {}), ...(input.inputPaths.length ? { inputPaths: input.inputPaths } : {}) }, mutationKeys.key("task-create", identity));
      if (!active.current) return;
      mutationKeys.complete("task-create", identity);
      toast.success("Task created");
      navigate(`${basePath}/${task.id}`);
    } catch (reason) {
      if (!active.current) return;
      const detail = message(reason);
      mutationKeys.completeApiFailure(reason, "task-create", identity);
      if (isReadOnlyMutationError(reason)) {
        setDialogOpen(false);
        mutationKeys.clear("task-create");
        if (reason instanceof ApiError && reason.status === 403) {
          setPage(emptyPage);
          await load();
          loadCreateDependencies();
          toast.error(detail);
          throw new Error(detail);
        }
        setCapabilities((current) => current ? { ...current, canCreateTasks: false } : current);
      } else if (isTaskEndpointDrift(reason)) {
        await loadEndpoints();
      }
      setError(detail);
      toast.error(detail);
      throw new Error(detail);
    } finally { if (active.current) setCreating(false); }
  }

  const compatibleEndpoints = taskCompatibleEndpoints(endpoints);
  const endpointGuidance = taskEndpointGuidance(endpoints);
  const canCreate = capabilitiesState === "ready" && capabilities?.canCreateTasks === true;
  const createReady = canCreate && endpointsState === "ready" && compatibleEndpoints.length > 0;

  function refresh() {
    void load();
    loadCreateDependencies();
  }

  return <PageLayout header={<PageHeader title="Tasks" subtitle="Create and follow Botified work for this project." actions={<><Button variant="quiet" size="icon" aria-label="Refresh tasks" title="Refresh tasks" onClick={refresh}><RefreshCw size={17} /></Button>{canCreate ? <Button onClick={() => setDialogOpen(true)} disabled={!createReady}><Plus size={17} />Create task</Button> : null}</>} />}>
    {error ? <div className="border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{error}</div> : null}
    {endpointsState === "error" ? <DependencyError>{endpointsError} Task creation is disabled until endpoints can be loaded.</DependencyError> : null}
    {capabilitiesState === "error" ? <DependencyError>{capabilitiesError} Task creation is disabled until project permissions can be loaded.</DependencyError> : null}
    {state === "loading" ? <PageState>Loading tasks...</PageState> : null}
    {state === "error" ? <PageState><Button onClick={() => void load()}>Try again</Button></PageState> : null}
    {state === "ready" ? <><TaskList page={page} basePath={basePath} query={query} pageIndex={pageIndex} onQueryChange={changeQuery} onNext={nextPage} onPrevious={() => setPageIndex((value) => Math.max(0, value - 1))} />{capabilitiesState === "ready" && !canCreate ? <p className="mt-4 text-sm text-secondary">Your project access is read-only.</p> : null}{canCreate && endpointsState === "ready" && endpointGuidance ? <p className="mt-4 text-sm text-secondary">{endpointGuidance} <Link className="font-medium text-foreground hover:underline" href={`/workspaces/${workspaceId}/projects/${projectId}/endpoints`}>Open endpoints</Link></p> : null}</> : null}
    <TaskCreateDialog projectId={projectId} canWriteFiles={capabilities?.canWriteFiles === true} endpoints={compatibleEndpoints} projectFiles={projectFiles} projectFilesLoading={projectFilesLoading} open={dialogOpen} saving={creating} onClose={() => { if (!creating) { setDialogOpen(false); mutationKeys.clear("task-create"); } }} onCreate={createTask} />
  </PageLayout>;
}

function DependencyError({ children }: { children: ReactNode }) {
  return <div className="border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning" role="alert">{children}</div>;
}

function message(error: unknown): string { return error instanceof ApiError ? error.message : error instanceof Error ? error.message : "The task request could not be completed."; }

function isTaskEndpointDrift(error: unknown): boolean {
  return error instanceof ApiError && (
    error.status === 404 && (error.message === "Endpoint not found" || error.message === "Credential not found")
    || error.status === 409 && error.message === "Endpoint is unavailable. Recheck it before use."
  );
}
