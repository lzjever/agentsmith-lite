"use client";

import { ChevronLeft, ChevronRight, FileOutput, RefreshCw } from "lucide-react";
import { IconButton, Selector, Text } from "@astryxdesign/core";
import { type TaskArtifact, type TaskArtifactKind } from "../../lib/api/client";
import { TaskArtifactActions } from "./TaskArtifactActions";
import { formatArtifactBytes, formatTaskDate } from "./task-ui";

type ArtifactFilter = "all" | TaskArtifactKind;

export function TaskArtifactsPanel({ taskId, artifacts, filter, hasNext, hasPrevious, onFilterChange, onNext, onPrevious, onRefresh, refreshing = false, emptyMessage = "No artifacts published yet." }: {
  taskId: string;
  artifacts: TaskArtifact[];
  filter: ArtifactFilter;
  hasNext: boolean;
  hasPrevious: boolean;
  onFilterChange: (filter: ArtifactFilter) => void | Promise<void>;
  onNext: () => void | Promise<void>;
  onPrevious: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  emptyMessage?: string;
}) {
  return <section aria-label="Published artifacts">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <Text type="supporting" color="secondary">{artifacts.length} on this page</Text>
      <div className="flex items-center gap-2">
        <Selector label="Artifact type" isLabelHidden options={[{ value: "all", label: "All types" }, { value: "text", label: "Text" }, { value: "image", label: "Images" }, { value: "file", label: "Files" }]} value={filter} onChange={(value) => void onFilterChange(value as ArtifactFilter)} isDisabled={refreshing} size="md" width={112} />
        {onRefresh ? <IconButton label="Refresh artifacts" tooltip="Refresh artifacts" variant="ghost" size="md" isDisabled={refreshing} isLoading={refreshing} icon={<RefreshCw size={15} />} onClick={() => void onRefresh()} /> : null}
      </div>
    </div>
    {artifacts.length === 0 ? <div className="grid min-h-36 place-items-center border border-dashed border-border px-5 text-center"><div><FileOutput className="mx-auto size-5 text-icon-secondary" /><Text display="block" type="supporting" color="secondary" className="mt-2">{filter === "all" ? emptyMessage : `No ${filter} artifacts published yet.`}</Text></div></div> : <div className="divide-y divide-border border border-border">{artifacts.map((artifact) => <ArtifactRow key={artifact.id} taskId={taskId} artifact={artifact} />)}</div>}
    {hasPrevious || hasNext ? <nav aria-label="Artifact pages" className="mt-3 flex justify-end gap-1"><IconButton label="Previous artifact page" tooltip="Previous page" variant="ghost" size="md" isDisabled={!hasPrevious || refreshing} icon={<ChevronLeft size={16} />} onClick={() => void onPrevious()} /><IconButton label="Next artifact page" tooltip="Next page" variant="ghost" size="md" isDisabled={!hasNext || refreshing} icon={<ChevronRight size={16} />} onClick={() => void onNext()} /></nav> : null}
  </section>;
}

function ArtifactRow({ taskId, artifact }: { taskId: string; artifact: TaskArtifact }) {
  return <div className="px-3 py-3">
    <div className="flex items-start gap-3"><FileOutput className="mt-0.5 size-4 shrink-0 text-icon-secondary" /><div className="min-w-0 flex-1"><Text display="block" type="supporting" className="break-words">{artifact.name}</Text><Text display="block" type="supporting" color="secondary" className="mt-0.5">{formatArtifactBytes(artifact.bytes)} · {artifact.mediaType ?? "file"} · {formatTaskDate(artifact.createdAt)}</Text></div></div>
    <TaskArtifactActions taskId={taskId} artifact={artifact} className="mt-2" />
  </div>;
}
