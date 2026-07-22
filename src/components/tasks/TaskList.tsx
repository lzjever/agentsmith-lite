"use client";

import { ArrowUpRight, ChevronLeft, ChevronRight, Clock3, Search, Wrench, X } from "lucide-react";
import { Button, Selector } from "@astryxdesign/core";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { TaskListItem, TaskListPage, TaskListQuery } from "../../lib/api/client";
import { Input } from "../ui/input";
import { formatTaskDate, taskProjectionLabel } from "./task-ui";

export function TaskList({ page, basePath, query, pageIndex, onQueryChange, onNext, onPrevious }: { page: TaskListPage; basePath: string; query: TaskListQuery; pageIndex: number; onQueryChange: (query: TaskListQuery) => void; onNext: () => void; onPrevious: () => void }) {
  const [search, setSearch] = useState(query.search ?? "");
  useEffect(() => setSearch(query.search ?? ""), [query.search]);

  function submitSearch(event: FormEvent) { event.preventDefault(); const value = search.trim(); onQueryChange(changeTaskQuery(query, value ? { search:value } : {}, ["cursor", ...(value ? [] : ["search" as const])])); }
  function clearFilters() { setSearch(""); onQueryChange({ archived:"exclude", sort:"updated_at", direction:"desc", ...(query.limit === undefined ? {} : { limit:query.limit }) }); }
  const filtered = Boolean(query.search || (query.archived && query.archived !== "exclude") || query.sort !== "updated_at" || query.direction !== "desc");

  return <section aria-label="Task list">
    <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-center">
      <form className="relative min-w-0 flex-1" onSubmit={submitSearch}><label><span className="sr-only">Search tasks</span><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary" /><Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9 pr-20" placeholder="Search tasks" /></label>{search ? <Button className="absolute right-10 top-0.5" label="Clear task search" size="lg" variant="ghost" isIconOnly icon={<X size={14} />} onClick={() => { setSearch(""); onQueryChange(changeTaskQuery(query, {}, ["search", "cursor"])); }} /> : null}<Button className="absolute right-1 top-0.5" label="Apply task search" size="lg" variant="ghost" isIconOnly icon={<Search size={14} />} type="submit" /></form>
      <Selector label="Task archive" isLabelHidden options={[{ value: "exclude", label: "Not archived" }, { value: "include", label: "All tasks" }, { value: "only", label: "Archived only" }]} value={query.archived ?? "exclude"} onChange={(value) => onQueryChange(changeTaskQuery(query, { archived:value as NonNullable<TaskListQuery["archived"]> }, ["cursor"]))} size="sm" className="w-full lg:w-36" />
      <Selector label="Sort tasks" isLabelHidden options={[{ value: "updated_at:desc", label: "Most recent" }, { value: "created_at:asc", label: "Oldest first" }, { value: "title:asc", label: "Task title" }]} value={`${query.sort ?? "updated_at"}:${query.direction ?? "desc"}`} onChange={(value) => { const [sort, direction] = value.split(":") as [NonNullable<TaskListQuery["sort"]>, NonNullable<TaskListQuery["direction"]>]; onQueryChange(changeTaskQuery(query, { sort, direction }, ["cursor"])); }} size="sm" className="w-full lg:w-40" />
    </div>
    {page.items.length === 0 ? <div className="grid min-h-52 place-items-center border border-dashed border-border px-6 text-center"><div><Wrench className="mx-auto size-6 text-icon-default" /><h2 className="type-title mt-3 text-foreground">{filtered ? "No tasks match" : "No tasks yet"}</h2><p className="mt-1 text-sm text-secondary">{filtered ? "Try a different search or filter." : "Create a task to run the project in a Botified sandbox."}</p>{filtered ? <Button className="mt-3" label="Clear filters" variant="ghost" size="lg" onClick={clearFilters} /> : null}</div></div> : <div className="overflow-hidden border border-border"><div className="hidden grid-cols-[minmax(0,1fr)_11rem_11rem] gap-4 border-b border-border bg-surface-low px-4 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-tertiary md:grid"><span>Task</span><span>State</span><span className="text-right">Updated</span></div>{page.items.map((item) => <TaskRow key={item.task.id} item={item} basePath={basePath} />)}</div>}
    {page.total > 0 ? <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Task pages"><p className="text-sm text-secondary">Page {pageIndex + 1} · {page.total} total</p><div className="flex gap-1"><Button label="Previous task page" variant="ghost" size="lg" isIconOnly icon={<ChevronLeft size={16} />} isDisabled={pageIndex === 0} onClick={onPrevious} /><Button label="Next task page" variant="ghost" size="lg" isIconOnly icon={<ChevronRight size={16} />} isDisabled={!page.nextCursor} onClick={onNext} /></div></nav> : null}
  </section>;
}

function TaskRow({ item, basePath }: { item: TaskListItem; basePath: string }) {
  const { task } = item;
  return <Link href={`${basePath}/${task.id}`} className="grid gap-2 border-b border-border px-4 py-3 last:border-b-0 hover:bg-hover md:grid-cols-[minmax(0,1fr)_11rem_11rem] md:items-center md:gap-4"><div className="min-w-0"><p className="truncate text-sm text-foreground">{task.title?.trim() || task.prompt}</p>{task.title ? <p className="mt-1 truncate text-xs text-secondary">{task.prompt}</p> : null}<p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-tertiary"><span className="flex items-center gap-1.5"><Clock3 size={12} />{task.id}</span>{item.lifecycle.state === "archived" ? <span>Archived</span> : null}</p></div><div className="flex items-center justify-between gap-3 md:contents"><div className="min-w-0"><span className={`block w-fit border px-2 py-0.5 font-mono text-[10px] uppercase ${stateClass(item)}`}>{taskProjectionLabel(item)}</span></div><span className="inline-flex items-center justify-end gap-1 text-xs text-secondary"><span>{formatTaskDate(task.updatedAt)}</span><ArrowUpRight size={15} /></span></div></Link>;
}
function stateClass(item: TaskListItem): string { return item.sandboxState.state === "failed" ? "border-error/40 bg-error/10 text-error" : item.sandboxState.state === "release_requested" ? "border-warning/40 bg-warning/10 text-warning" : item.sandboxState.state === "active" && item.currentTurn.state === "running" ? "border-success/40 bg-success/10 text-success" : "border-border text-secondary"; }

function changeTaskQuery(query: TaskListQuery, changes: Partial<TaskListQuery>, remove: Array<keyof TaskListQuery>): TaskListQuery {
  const next = { ...query, ...changes };
  for (const key of remove) delete next[key];
  return next;
}
