"use client";

import { Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiClient, type Endpoint, type ProjectCapabilities, type TaskListPage, type TaskListQuery, type TaskSummary } from "../../lib/api/client";
import { PageHeader } from "../layout/PageHeader";
import { PageLayout } from "../layout/PageLayout";
import { PageState } from "../layout/PageState";
import { Button } from "../ui/button";
import { toast } from "../ui/toast";
import { TaskCreateDialog } from "./TaskCreateDialog";
import { TaskList } from "./TaskList";
import { taskCompatibleEndpoints } from "./task-ui";
import { useTaskMutationKeys } from "./task-mutation-key";

const emptyPage: TaskListPage = { items: [], nextCursor: null, total: 0 };
const initialQuery: TaskListQuery = { archived: "exclude", sort: "updated_at", direction: "desc", limit: 25 };

export function TasksPage({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const router = useRouter();
  const mutationKeys = useTaskMutationKeys();
  const [page, setPage] = useState<TaskListPage>(emptyPage);
  const [summaries, setSummaries] = useState<TaskSummary[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [capabilities, setCapabilities] = useState<ProjectCapabilities>();
  const [query, setQuery] = useState<TaskListQuery>(initialQuery);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const loadVersion = useRef(0);
  const basePath = `/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const cursor = cursors[pageIndex];

  const load = useCallback(async (quiet = false) => {
    const version = ++loadVersion.current;
    if (!quiet) setState("loading");
    try {
      const [listed, listedSummaries, available, projected] = await Promise.all([
        apiClient.tasks(projectId, { ...query, ...(cursor ? { cursor } : {}) }),
        apiClient.taskSummaries(projectId),
        apiClient.endpoints(projectId),
        apiClient.projectCapabilities(projectId)
      ]);
      if (version !== loadVersion.current) return;
      setPage(listed);
      setSummaries(listedSummaries);
      setEndpoints(available);
      setCapabilities(projected);
      setError("");
      setState("ready");
    } catch (reason) {
      if (version !== loadVersion.current) return;
      setError(message(reason));
      setState("error");
    }
  }, [cursor, projectId, query]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!page.items.some((task) => ["queued", "starting", "running", "stopping"].includes(task.status))) return;
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

  async function createTask(input: { title: string; prompt: string; endpointId: string }) {
    setCreating(true);
    setError("");
    const identity = JSON.stringify(input);
    try {
      const title = input.title.trim();
      const task = await apiClient.createTask(projectId, { prompt: input.prompt, endpointId: input.endpointId, ...(title ? { title } : {}) }, mutationKeys.key("task-create", identity));
      mutationKeys.complete("task-create", identity);
      toast.success("Task created");
      router.push(`${basePath}/${task.id}`);
    } catch (reason) {
      const detail = message(reason);
      setError(detail);
      toast.error(detail);
      throw new Error(detail);
    } finally { setCreating(false); }
  }

  const compatibleEndpoints = taskCompatibleEndpoints(endpoints);
  const canCreate = capabilities?.canCreateTasks === true;

  return <PageLayout header={<PageHeader title="Tasks" subtitle="Create and follow Botified work for this project." actions={<><Button variant="quiet" size="icon" aria-label="Refresh tasks" title="Refresh tasks" onClick={() => void load()}><RefreshCw size={17} /></Button>{canCreate ? <Button onClick={() => setDialogOpen(true)} disabled={compatibleEndpoints.length === 0}><Plus size={17} />Create task</Button> : null}</>} />}>
    {error ? <div className="border border-error/30 bg-error/10 px-3 py-2 text-sm text-error" role="alert">{error}</div> : null}
    {state === "loading" ? <PageState>Loading tasks...</PageState> : null}
    {state === "error" ? <PageState><Button onClick={() => void load()}>Try again</Button></PageState> : null}
    {state === "ready" ? <><TaskList page={page} summaries={summaries} basePath={basePath} query={query} pageIndex={pageIndex} onQueryChange={changeQuery} onNext={nextPage} onPrevious={() => setPageIndex((value) => Math.max(0, value - 1))} />{!canCreate ? <p className="mt-4 text-sm text-secondary">Your project access is read-only.</p> : null}{canCreate && compatibleEndpoints.length === 0 ? <p className="mt-4 text-sm text-secondary">Add an endpoint with text and tool-call support before creating a task.</p> : null}</> : null}
    <TaskCreateDialog endpoints={compatibleEndpoints} open={dialogOpen} saving={creating} onClose={() => { if (!creating) { setDialogOpen(false); mutationKeys.clear("task-create"); } }} onCreate={createTask} />
  </PageLayout>;
}

function message(error: unknown): string { return error instanceof ApiError ? error.message : error instanceof Error ? error.message : "The task request could not be completed."; }
