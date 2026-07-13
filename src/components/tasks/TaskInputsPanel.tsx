"use client";

import { Download, FileInput } from "lucide-react";
import { apiClient, type TaskInput } from "../../lib/api/client";
import { formatArtifactBytes } from "./task-ui";

export function TaskInputsPanel({ taskId, inputs, selectedPaths }: { taskId: string; inputs: TaskInput[]; selectedPaths: string[] }) {
  if (inputs.length === 0) {
    return <div className="grid min-h-36 place-items-center border border-dashed border-border px-4 text-center"><div><FileInput className="mx-auto size-5 text-icon-default" /><p className="mt-2 text-sm text-secondary">No project files were attached.</p></div></div>;
  }
  return <div className="space-y-3">
    {selectedPaths.length ? <div><p className="type-caption text-tertiary">Selected paths</p><ul className="mt-2 space-y-1">{selectedPaths.map((path) => <li key={path} className="break-all font-mono text-xs text-secondary">{path}</li>)}</ul></div> : null}
    <div className="divide-y divide-border border border-border">{inputs.map((input) => <div key={input.path} className="flex items-center gap-3 px-3 py-3"><FileInput className="size-4 shrink-0 text-icon-default" /><div className="min-w-0 flex-1"><p className="truncate text-sm text-foreground" title={input.path}>{input.name}</p><p className="mt-0.5 text-xs text-tertiary">{formatArtifactBytes(input.bytes)}</p></div><a className="grid size-9 shrink-0 place-items-center text-secondary hover:bg-hover hover:text-foreground" aria-label={`Download ${input.name}`} title={`Download ${input.name}`} href={apiClient.taskInputDownloadUrl(taskId, input.path)}><Download size={16} /></a></div>)}</div>
  </div>;
}
