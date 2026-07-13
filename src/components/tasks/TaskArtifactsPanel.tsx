"use client";

import { Download, FileOutput, Image as ImageIcon, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, apiClient, type TaskArtifact } from "../../lib/api/client";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { formatArtifactBytes, formatTaskDate } from "./task-ui";

export function TaskArtifactsPanel({ taskId, artifacts, onRefresh, refreshing = false }: { taskId: string; artifacts: TaskArtifact[]; onRefresh?: () => void | Promise<void>; refreshing?: boolean }) {
  const [filter, setFilter] = useState<"all" | "text" | "image" | "file">("all");
  const visibleArtifacts = useMemo(() => artifacts.filter((artifact) => filter === "all" || artifactKind(artifact) === filter), [artifacts, filter]);
  return <section aria-label="Published artifacts"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-secondary">{artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}</p><div className="flex items-center gap-2"><Select value={filter} onValueChange={(value) => setFilter(value as typeof filter)}><SelectTrigger aria-label="Artifact type" className="h-8 w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All types</SelectItem><SelectItem value="text">Text</SelectItem><SelectItem value="image">Images</SelectItem><SelectItem value="file">Files</SelectItem></SelectContent></Select>{onRefresh ? <Button variant="quiet" size="icon" aria-label="Refresh artifacts" title="Refresh artifacts" disabled={refreshing} onClick={() => void onRefresh()}><RefreshCw size={15} className={refreshing ? "animate-spin" : undefined} /></Button> : null}</div></div>{artifacts.length === 0 ? <div className="grid min-h-36 place-items-center border border-dashed border-border px-5 text-center"><div><FileOutput className="mx-auto size-5 text-icon-default" /><p className="mt-2 text-sm text-secondary">No artifacts published yet.</p></div></div> : visibleArtifacts.length === 0 ? <div className="grid min-h-28 place-items-center border border-dashed border-border px-5 text-center"><p className="text-sm text-secondary">No {filter} artifacts published yet.</p></div> : <div className="divide-y divide-border border border-border">{visibleArtifacts.map((artifact) => <ArtifactRow key={artifact.id} taskId={taskId} artifact={artifact} />)}</div>}</section>;
}

function artifactKind(artifact: TaskArtifact): "text" | "image" | "file" { if (artifact.mediaType?.startsWith("image/")) return "image"; if (artifact.mediaType?.startsWith("text/")) return "text"; return "file"; }

function ArtifactRow({ taskId, artifact }: { taskId: string; artifact: TaskArtifact }) {
  const [textOpen, setTextOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const safeText = artifact.mediaType?.startsWith("text/") && artifact.mediaType !== "text/html" && artifact.previewText;
  const safeImage = artifact.mediaType?.startsWith("image/") === true;
  return <div className="px-3 py-3">
    <div className="flex items-start gap-3"><FileOutput className="mt-0.5 size-4 shrink-0 text-icon-default" /><div className="min-w-0 flex-1"><p className="break-words text-sm text-foreground">{artifact.name}</p><p className="mt-0.5 text-xs text-secondary">{formatArtifactBytes(artifact.bytes)} · {artifact.mediaType ?? "file"} · {formatTaskDate(artifact.createdAt)}</p></div></div>
    <div className="mt-2 flex min-h-9 items-center justify-end gap-1">{safeText ? <Button variant="quiet" size="sm" onClick={() => setTextOpen((open) => !open)}>{textOpen ? "Hide preview" : "Preview"}</Button> : null}{safeImage ? <Button variant="quiet" size="icon" aria-label={`View ${artifact.name}`} title={`View ${artifact.name}`} onClick={() => setImageOpen(true)}><ImageIcon size={16} /></Button> : null}<a className="grid size-9 place-items-center text-secondary hover:bg-hover hover:text-foreground" aria-label={`Download ${artifact.name}`} title={`Download ${artifact.name}`} href={apiClient.artifactDownloadUrl(taskId, artifact.id)}><Download size={16} /></a></div>
    {textOpen && safeText ? <pre className="mt-3 max-h-64 overflow-auto border border-border bg-surface-low p-3 text-xs text-foreground">{artifact.previewText}</pre> : null}
    {safeImage ? <ArtifactImageViewer taskId={taskId} artifact={artifact} open={imageOpen} onOpenChange={setImageOpen} /> : null}
  </div>;
}

function ArtifactImageViewer({ taskId, artifact, open, onOpenChange }: { taskId: string; artifact: TaskArtifact; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => {
    if (!open || url || loading) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true); setError(null);
    void apiClient.downloadTaskArtifact(taskId, artifact.id, controller.signal).then((blob) => {
      if (cancelled) return;
      setUrl(URL.createObjectURL(new Blob([blob], { type: artifact.mediaType ?? "application/octet-stream" })));
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof ApiError ? reason.message : "Image preview could not be loaded.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; controller.abort(); };
  }, [artifact.id, artifact.mediaType, open, reloadKey, taskId]);

  function close(nextOpen: boolean) {
    if (!nextOpen) {
      setUrl(null); setError(null); setLoading(false);
    }
    onOpenChange(nextOpen);
  }

  return <Dialog open={open} onOpenChange={close}><DialogContent aria-describedby={undefined} className="max-h-[min(48rem,calc(100vh-2rem))] overflow-auto"><DialogHeader title={artifact.name} description={`${formatArtifactBytes(artifact.bytes)} · ${artifact.mediaType}`} />{loading ? <div className="grid min-h-64 place-items-center text-sm text-secondary"><Loader2 className="size-5 animate-spin" />Loading image…</div> : null}{error ? <div className="p-5"><p role="alert" className="text-sm text-error">{error}</p><Button className="mt-4" onClick={() => { setError(null); setUrl(null); setReloadKey((key) => key + 1); }}>Try again</Button></div> : null}{url ? <img src={url} alt={artifact.name} className="mx-auto block max-h-[70vh] max-w-full object-contain p-5" /> : null}<div className="flex justify-end border-t border-subtle px-5 py-4"><DialogClose asChild><Button variant="ghost">Close</Button></DialogClose></div></DialogContent></Dialog>;
}
