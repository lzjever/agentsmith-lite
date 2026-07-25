"use client";

import { Download, Image as ImageIcon } from "lucide-react";
import { Banner, Button, IconButton, Spinner, Text } from "@astryxdesign/core";
import { useEffect, useState } from "react";
import { ApiError, apiClient } from "../../lib/api/client";
import {
  createInlinePreviewRequest,
  inlinePreviewPolicy,
  isInlinePreviewAvailable,
  type InlinePreviewByteLimits
} from "../media/inline-preview";
import { Dialog } from "../ui/Dialog";
import { formatArtifactBytes } from "./task-ui";

const artifactPreviewByteLimits = { text: 512 * 1024, image: 8 * 1024 * 1024 } satisfies InlinePreviewByteLimits;

export type PreviewableTaskArtifact = {
  id: string;
  name: string;
  bytes: number;
  mediaType?: string | null;
  previewText?: string | null;
};

export function TaskArtifactActions({ taskId, artifact, available = true, className }: { taskId: string; artifact: PreviewableTaskArtifact; available?: boolean; className?: string }) {
  const [textOpen, setTextOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const previewPolicy = inlinePreviewPolicy(artifact.mediaType, artifactPreviewByteLimits);
  const previewAvailable = isInlinePreviewAvailable(artifact, artifactPreviewByteLimits);
  const safeText = previewPolicy?.kind === "text" && previewAvailable;
  const safeImage = previewPolicy?.kind === "image" && previewAvailable;

  if (!available) return null;

  return <div className={className}>
    <div className="flex min-h-9 items-center justify-end gap-1">{safeText ? <Button label={textOpen ? "Hide preview" : "Preview"} variant="ghost" size="sm" onClick={() => setTextOpen((open) => !open)} /> : null}{safeImage ? <IconButton label={`View ${artifact.name}`} tooltip={`View ${artifact.name}`} variant="ghost" icon={<ImageIcon size={16} />} onClick={() => setImageOpen(true)} /> : null}<IconButton as="a" label={`Download ${artifact.name}`} tooltip={`Download ${artifact.name}`} variant="ghost" icon={<Download size={16} />} href={apiClient.artifactDownloadUrl(taskId, artifact.id)} /></div>
    {textOpen && safeText ? <ArtifactTextPreview taskId={taskId} artifact={artifact} /> : null}
    {safeImage ? <ArtifactImageViewer taskId={taskId} artifact={artifact} open={imageOpen} onOpenChange={setImageOpen} /> : null}
  </div>;
}

function ArtifactTextPreview({ taskId, artifact }: { taskId: string; artifact: PreviewableTaskArtifact }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    const request = createInlinePreviewRequest({
      mediaType: artifact.mediaType,
      bytes: artifact.bytes,
      previewText: artifact.previewText,
      byteLimits: artifactPreviewByteLimits,
      load: (signal) => apiClient.downloadTaskArtifact(taskId, artifact.id, signal)
    });
    void request.result.then((preview) => {
      if (!cancelled && preview.kind === "text") setText(preview.text);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof ApiError || reason instanceof Error ? reason.message : "Text preview could not be loaded.");
    });
    return () => { cancelled = true; request.dispose(); };
  }, [artifact.bytes, artifact.id, artifact.mediaType, artifact.previewText, reloadKey, taskId]);

  if (error) return <div className="mt-3"><Banner status="error" title="Preview unavailable" description={error} /><Button className="mt-3" label="Try again" onClick={() => { setError(null); setText(null); setReloadKey((key) => key + 1); }} /></div>;
  if (text === null) return <div className="mt-3 grid min-h-24 place-items-center text-secondary"><Spinner size="sm" label="Loading preview..." /></div>;
  return <pre className="mt-3 max-h-64 overflow-auto border border-border bg-muted p-3 text-primary"><Text type="code">{text}</Text></pre>;
}

function ArtifactImageViewer({ taskId, artifact, open, onOpenChange }: { taskId: string; artifact: PreviewableTaskArtifact; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open || url || loading) return;
    let cancelled = false;
    setLoading(true); setError(null);
    const request = createInlinePreviewRequest({
      mediaType: artifact.mediaType,
      bytes: artifact.bytes,
      byteLimits: artifactPreviewByteLimits,
      load: (signal) => apiClient.downloadTaskArtifact(taskId, artifact.id, signal)
    });
    void request.result.then((preview) => {
      if (!cancelled && preview.kind === "image") setUrl(preview.url);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof ApiError || reason instanceof Error ? reason.message : "Image preview could not be loaded.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; request.dispose(); };
  }, [artifact.bytes, artifact.id, artifact.mediaType, open, reloadKey, taskId]);

  function close(nextOpen: boolean) {
    if (!nextOpen) {
      setUrl(null); setError(null); setLoading(false);
    }
    onOpenChange(nextOpen);
  }

  return <Dialog isOpen={open} onOpenChange={close} mode="info" title={artifact.name} subtitle={`${formatArtifactBytes(artifact.bytes)} · ${artifact.mediaType}`} contentPadding={0}>{loading ? <div className="grid min-h-64 place-items-center text-secondary"><Spinner label="Loading image..." /></div> : null}{error ? <div className="p-5"><Banner status="error" title="Image preview unavailable" description={error} /><Button className="mt-4" label="Try again" onClick={() => { setError(null); setUrl(null); setReloadKey((key) => key + 1); }} /></div> : null}{url ? <img src={url} alt={artifact.name} className="mx-auto block max-h-[70dvh] max-w-full object-contain p-5" /> : null}</Dialog>;
}
