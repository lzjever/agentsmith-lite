"use client";

import { ArrowUpRight, ChevronLeft, ChevronRight, Clock3, Search, Wrench, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { Task, TaskListPage, TaskListQuery, TaskStatus } from "../../lib/api/client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { formatTaskDate, taskFinalizationPresentation, taskResultLabel } from "./task-ui";

const statuses: Array<{ value: "all" | TaskStatus; label: string }> = [
  { value: "all", label: "All statuses" }, { value: "queued", label: "Queued" }, { value: "starting", label: "Starting" },
  { value: "running", label: "Running" }, { value: "stopping", label: "Stopping" }, { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" }, { value: "cancelled", label: "Cancelled" }, { value: "expired", label: "Expired" }, { value: "cleaned", label: "Cleaned up" }
];

export function TaskList({ page, basePath, query, pageIndex, onQueryChange, onNext, onPrevious }: { page: TaskListPage; basePath: string; query: TaskListQuery; pageIndex: number; onQueryChange: (query: TaskListQuery) => void; onNext: () => void; onPrevious: () => void }) {
  const [search, setSearch] = useState(query.search ?? "");
  useEffect(() => setSearch(query.search ?? ""), [query.search]);

  function submitSearch(event: FormEvent) { event.preventDefault(); onQueryChange({ ...query, search: search.trim() || undefined, cursor: undefined }); }
  function clearFilters() { setSearch(""); onQueryChange({ archived: "exclude", sort: "updated_at", direction: "desc", limit: query.limit }); }
  const filtered = Boolean(query.search || query.statuses?.length || (query.archived && query.archived !== "exclude") || query.sort !== "updated_at" || query.direction !== "desc");

  return <section aria-label="Task list">
    <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-center">
      <form className="relative min-w-0 flex-1" onSubmit={submitSearch}><label><span className="sr-only">Search tasks</span><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary" /><Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9 pr-20" placeholder="Search tasks" /></label>{search ? <Button className="absolute right-10 top-0.5" size="icon" variant="quiet" aria-label="Clear task search" onClick={() => { setSearch(""); onQueryChange({ ...query, search: undefined, cursor: undefined }); }}><X size={14} /></Button> : null}<Button className="absolute right-1 top-0.5" size="icon" variant="quiet" aria-label="Apply task search" type="submit"><Search size={14} /></Button></form>
      <Select value={query.statuses?.[0] ?? "all"} onValueChange={(value) => onQueryChange({ ...query, statuses: value === "all" ? undefined : [value as TaskStatus], cursor: undefined })}><SelectTrigger className="h-9 w-full lg:w-40" aria-label="Task status"><SelectValue /></SelectTrigger><SelectContent>{statuses.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select>
      <Select value={query.archived ?? "exclude"} onValueChange={(value) => onQueryChange({ ...query, archived: value as TaskListQuery["archived"], cursor: undefined })}><SelectTrigger className="h-9 w-full lg:w-36" aria-label="Task archive"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="exclude">Active only</SelectItem><SelectItem value="include">All tasks</SelectItem><SelectItem value="only">Archived</SelectItem></SelectContent></Select>
      <Select value={`${query.sort ?? "updated_at"}:${query.direction ?? "desc"}`} onValueChange={(value) => { const [sort, direction] = value.split(":") as [NonNullable<TaskListQuery["sort"]>, NonNullable<TaskListQuery["direction"]>]; onQueryChange({ ...query, sort, direction, cursor: undefined }); }}><SelectTrigger className="h-9 w-full lg:w-40" aria-label="Sort tasks"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="updated_at:desc">Most recent</SelectItem><SelectItem value="created_at:asc">Oldest first</SelectItem><SelectItem value="title:asc">Task title</SelectItem><SelectItem value="status:asc">Status</SelectItem></SelectContent></Select>
    </div>
    {page.items.length === 0 ? <div className="grid min-h-52 place-items-center border border-dashed border-border px-6 text-center"><div><Wrench className="mx-auto size-6 text-icon-default" /><h2 className="type-title mt-3 text-foreground">{filtered ? "No tasks match" : "No tasks yet"}</h2><p className="mt-1 text-sm text-secondary">{filtered ? "Try a different search or filter." : "Create a task to run the project in a Botified sandbox."}</p>{filtered ? <Button className="mt-3" variant="quiet" onClick={clearFilters}>Clear filters</Button> : null}</div></div> : <div className="overflow-hidden border border-border"><div className="hidden grid-cols-[minmax(0,1fr)_11rem_11rem] gap-4 border-b border-border bg-surface-low px-4 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-tertiary md:grid"><span>Task</span><span>Status</span><span className="text-right">Updated</span></div>{page.items.map((task) => <TaskRow key={task.id} task={task} basePath={basePath} />)}</div>}
    {page.total > 0 ? <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Task pages"><p className="text-sm text-secondary">Page {pageIndex + 1} · {page.total} total</p><div className="flex gap-1"><Button variant="quiet" size="icon" aria-label="Previous task page" disabled={pageIndex === 0} onClick={onPrevious}><ChevronLeft size={16} /></Button><Button variant="quiet" size="icon" aria-label="Next task page" disabled={!page.nextCursor} onClick={onNext}><ChevronRight size={16} /></Button></div></nav> : null}
  </section>;
}

function TaskRow({ task, basePath }: { task: Task; basePath: string }) {
  const finalization = taskFinalizationPresentation(task);
  return <Link href={`${basePath}/${task.id}`} className="grid gap-2 border-b border-border px-4 py-3 last:border-b-0 hover:bg-hover md:grid-cols-[minmax(0,1fr)_11rem_11rem] md:items-center md:gap-4"><div className="min-w-0"><p className="truncate text-sm text-foreground">{task.title?.trim() || task.prompt}</p>{task.title ? <p className="mt-1 truncate text-xs text-secondary">{task.prompt}</p> : null}<p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-tertiary"><span className="flex items-center gap-1.5"><Clock3 size={12} />{task.id}</span>{task.archivedAt ? <span>Archived</span> : null}{task.sourceTaskId ? <span>Successor of {task.sourceTaskId}</span> : null}</p></div><div className="flex items-center justify-between gap-3 md:contents"><div className="min-w-0"><span className={`block w-fit border px-2 py-0.5 font-mono text-[10px] uppercase ${statusClass(task.status)}`}>{taskResultLabel(task)}</span>{finalization ? <p className={`mt-1 text-xs ${finalization.tone === "warning" ? "text-warning" : "text-secondary"}`}>{finalization.tone === "warning" ? "Finalization needs attention" : finalization.label}</p> : null}</div><span className="inline-flex items-center justify-end gap-1 text-xs text-secondary"><span>{formatTaskDate(task.updatedAt)}</span><ArrowUpRight size={15} /></span></div></Link>;
}
function statusClass(status: TaskStatus): string { return status === "failed" ? "border-error/40 bg-error/10 text-error" : status === "stopping" ? "border-warning/40 bg-warning/10 text-warning" : status === "running" ? "border-success/40 bg-success/10 text-success" : "border-border text-secondary"; }
