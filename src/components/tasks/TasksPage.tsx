"use client";

import { Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiClient, isReadOnlyMutationError, type Endpoint, type ProjectCapabilities, type ProjectFile, type TaskListPage, type TaskListQuery, type TaskStatus } from "../../lib/api/client";
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
const taskStatuses: TaskStatus[] = ["queued", "starting", "running", "stopping", "completed", "failed", "expired", "cleaned", "cancelled"];
const taskSorts = new Set(["updated_at:desc", "created_at:asc", "title:asc", "status:asc"]);
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
  const [queryReady, setQueryReady] = useState(false);
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
  useEffect(() => {
    function restoreQuery() {
      const restored = taskQueryFromLocation();
      setQuery(restored);
      setCursors([undefined]);
      setPageIndex(0);
      replaceTaskQuery(restored);
      setQueryReady(true);
    }
    restoreQuery();
    window.addEventListener("popstate", restoreQuery);
    return () => window.removeEventListener("popstate", restoreQuery);
  }, []);

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

  useEffect(() => { if (queryReady) void load(); }, [load, queryReady]);
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
    const normalized = { ...next, cursor: undefined, limit: next.limit ?? 25 };
    writeTaskQuery(normalized, "push");
    setQuery(normalized);
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
        setError(detail);
        toast.error(detail);
      } else if (isTaskEndpointDrift(reason)) {
        await loadEndpoints();
      }
      throw reason instanceof Error ? reason : new Error(detail);
    } finally { if (active.current) setCreating(false); }
  }

  const compatibleEndpoints = taskCompatibleEndpoints(endpoints);
  const endpointGuidance = taskEndpointGuidance(endpoints);
  const canCreate = capabilitiesState === "ready" && capabilities?.canCreateTasks === true;
  const createReady = canCreate && endpointsState === "ready" && compatibleEndpoints.length > 0;
  const subtitle = canCreate ? "Create and follow Botified work for this project." : "Follow Botified work for this project.";

  function refresh() {
    void load();
    loadCreateDependencies();
  }

  return <PageLayout header={<PageHeader title="Tasks" subtitle={subtitle} actions={<><Button variant="quiet" size="icon" aria-label="Refresh tasks" title="Refresh tasks" onClick={refresh}><RefreshCw size={17} /></Button>{canCreate ? <Button onClick={() => setDialogOpen(true)} disabled={!createReady}><Plus size={17} />Create task</Button> : null}</>} />}>
    {error ? <div className="border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{error}</div> : null}
    {endpointsState === "error" ? <DependencyError>{endpointsError} Task creation is disabled until endpoints can be loaded.</DependencyError> : null}
    {capabilitiesState === "error" ? <DependencyError>{capabilitiesError} Task creation is disabled until project permissions can be loaded.</DependencyError> : null}
    {state === "loading" ? <PageState>Loading tasks...</PageState> : null}
    {state === "error" ? <PageState><Button onClick={() => void load()}>Try again</Button></PageState> : null}
    {state === "ready" ? <><TaskList page={page} basePath={basePath} query={query} pageIndex={pageIndex} onQueryChange={changeQuery} onNext={nextPage} onPrevious={() => setPageIndex((value) => Math.max(0, value - 1))} />{capabilitiesState === "ready" && !canCreate ? <p className="mt-4 text-sm text-secondary">Your project access is read-only.</p> : null}{canCreate && endpointsState === "ready" && endpointGuidance ? <p className="mt-4 text-sm text-secondary">{endpointGuidance} <Link className="font-medium text-foreground hover:underline" href={`/workspaces/${workspaceId}/projects/${projectId}/endpoints`}>Open endpoints</Link></p> : null}</> : null}
    <TaskCreateDialog projectId={projectId} policyHref={`/workspaces/${workspaceId}/projects/${projectId}/policy`} canWriteFiles={capabilities?.canWriteFiles === true} endpoints={compatibleEndpoints} projectFiles={projectFiles} projectFilesLoading={projectFilesLoading} open={dialogOpen} saving={creating} onClose={() => { if (!creating) { setDialogOpen(false); mutationKeys.clear("task-create"); } }} onCreate={createTask} />
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

function taskQueryFromLocation(): TaskListQuery {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  const archived = params.get("archived");
  const sort = params.get("sort");
  const direction = params.get("direction");
  const search = params.get("search")?.trim();
  const sortPair = `${sort ?? "updated_at"}:${direction ?? "desc"}`;
  const validSortPair = taskSorts.has(sortPair) ? sortPair : "updated_at:desc";
  const [validSort, validDirection] = validSortPair.split(":") as [NonNullable<TaskListQuery["sort"]>, NonNullable<TaskListQuery["direction"]>];
  return {
    ...(status && taskStatuses.includes(status as TaskStatus) ? { statuses: [status as TaskStatus] } : {}),
    archived: archived === "include" || archived === "only" ? archived : "exclude",
    sort: validSort,
    direction: validDirection,
    ...(search ? { search } : {}),
    limit: 25
  };
}

function replaceTaskQuery(query: TaskListQuery) {
  writeTaskQuery(query, "replace");
}

function writeTaskQuery(query: TaskListQuery, navigation: "push" | "replace") {
  const params = new URLSearchParams(window.location.search);
  for (const key of ["search", "status", "archived", "sort", "direction"]) params.delete(key);
  if (query.search) params.set("search", query.search);
  if (query.statuses?.[0]) params.set("status", query.statuses[0]);
  if (query.archived && query.archived !== "exclude") params.set("archived", query.archived);
  if (query.sort !== "updated_at" || query.direction !== "desc") {
    params.set("sort", query.sort ?? "updated_at");
    params.set("direction", query.direction ?? "desc");
  }
  const href = `${window.location.pathname}${params.size ? `?${params}` : ""}${window.location.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (navigation === "push" && href !== current) window.history.pushState(window.history.state, "", href);
  else window.history.replaceState(window.history.state, "", href);
}
