"use client";

import { FileOutput, RefreshCw } from "lucide-react";
import { Button, Selector } from "@astryxdesign/core";
import { useMemo, useState } from "react";
import { type TaskArtifact } from "../../lib/api/client";
import { isPreviewableText, TaskArtifactActions } from "./TaskArtifactActions";
import { formatArtifactBytes, formatTaskDate } from "./task-ui";

export function TaskArtifactsPanel({ taskId, artifacts, onRefresh, refreshing = false, emptyMessage = "No artifacts published yet." }: { taskId: string; artifacts: TaskArtifact[]; onRefresh?: () => void | Promise<void>; refreshing?: boolean; emptyMessage?: string }) {
  const [filter, setFilter] = useState<"all" | "text" | "image" | "file">("all");
  const visibleArtifacts = useMemo(() => artifacts.filter((artifact) => filter === "all" || artifactKind(artifact) === filter), [artifacts, filter]);
  return <section aria-label="Published artifacts"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-secondary">{artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}</p><div className="flex items-center gap-2"><Selector label="Artifact type" isLabelHidden options={[{ value: "all", label: "All types" }, { value: "text", label: "Text" }, { value: "image", label: "Images" }, { value: "file", label: "Files" }]} value={filter} onChange={(value) => setFilter(value as typeof filter)} size="md" width={112} />{onRefresh ? <Button label="Refresh artifacts" title="Refresh artifacts" variant="ghost" size="md" isIconOnly isDisabled={refreshing} icon={<RefreshCw size={15} className={refreshing ? "animate-spin" : undefined} />} onClick={() => void onRefresh()} /> : null}</div></div>{artifacts.length === 0 ? <div className="grid min-h-36 place-items-center border border-dashed border-border px-5 text-center"><div><FileOutput className="mx-auto size-5 text-icon-default" /><p className="mt-2 text-sm text-secondary">{emptyMessage}</p></div></div> : visibleArtifacts.length === 0 ? <div className="grid min-h-28 place-items-center border border-dashed border-border px-5 text-center"><p className="text-sm text-secondary">No {filter} artifacts published yet.</p></div> : <div className="divide-y divide-border border border-border">{visibleArtifacts.map((artifact) => <ArtifactRow key={artifact.id} taskId={taskId} artifact={artifact} />)}</div>}</section>;
}

function artifactKind(artifact: TaskArtifact): "text" | "image" | "file" { if (artifact.mediaType?.startsWith("image/")) return "image"; if (isPreviewableText(artifact.mediaType)) return "text"; return "file"; }

function ArtifactRow({ taskId, artifact }: { taskId: string; artifact: TaskArtifact }) {
  return <div className="px-3 py-3">
    <div className="flex items-start gap-3"><FileOutput className="mt-0.5 size-4 shrink-0 text-icon-default" /><div className="min-w-0 flex-1"><p className="break-words text-sm text-foreground">{artifact.name}</p><p className="mt-0.5 text-xs text-secondary">{formatArtifactBytes(artifact.bytes)} · {artifact.mediaType ?? "file"} · {formatTaskDate(artifact.createdAt)}</p></div></div>
    <TaskArtifactActions taskId={taskId} artifact={artifact} className="mt-2" />
  </div>;
}
