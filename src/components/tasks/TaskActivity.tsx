import { Activity } from "lucide-react";
import type { TaskEvent } from "../../lib/api/client";
import { activityCopy, formatTaskDate } from "./task-ui";

export function TaskActivity({ events }: { events: TaskEvent[] }) {
  if (events.length === 0) return <div className="grid min-h-40 place-items-center border border-dashed border-border px-5 text-center"><div><Activity className="mx-auto size-5 text-icon-default" /><p className="mt-2 text-sm text-secondary">Activity will appear as the task runs.</p></div></div>;
  return <ol className="border-l border-border pl-5">{events.map((event) => { const copy = activityCopy(event); return <li key={event.id} className="relative pb-6 last:pb-0"><span className="absolute -left-[1.65rem] top-1.5 size-2 rounded-full bg-accent" /><div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><h3 className="text-sm font-medium text-foreground">{copy.title}</h3><time className="font-mono text-[10px] text-tertiary">{formatTaskDate(event.createdAt)}</time></div>{copy.detail ? <p className="mt-1 whitespace-pre-wrap text-sm text-secondary">{copy.detail}</p> : null}</li>; })}</ol>;
}
