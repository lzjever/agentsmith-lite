"use client";

import { Download, Image as ImageIcon } from "lucide-react";
import { Banner, Button, DialogHeader, IconButton, Layout, LayoutContent, LayoutFooter, Spinner, Text } from "@astryxdesign/core";
import { useEffect, useState } from "react";
import { classifyPreviewMediaType } from "../../../packages/contracts/src/api";
import { ApiError, apiClient } from "../../lib/api/client";
import { Dialog } from "../ui/Dialog";
import { formatArtifactBytes } from "./task-ui";

const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_PREVIEW_CHARACTERS = 16_000;

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
  const previewKind = classifyPreviewMediaType(artifact.mediaType);
  const safeText = previewKind === "text" && (artifact.previewText !== null && artifact.previewText !== undefined || artifact.bytes <= MAX_TEXT_PREVIEW_BYTES);
  const safeImage = previewKind === "image" && artifact.bytes <= MAX_IMAGE_PREVIEW_BYTES;

  if (!available) return null;

  return <div className={className}>
    <div className="flex min-h-9 items-center justify-end gap-1">{safeText ? <Button label={textOpen ? "Hide preview" : "Preview"} variant="ghost" size="sm" onClick={() => setTextOpen((open) => !open)} /> : null}{safeImage ? <IconButton label={`View ${artifact.name}`} tooltip={`View ${artifact.name}`} variant="ghost" icon={<ImageIcon size={16} />} onClick={() => setImageOpen(true)} /> : null}<IconButton as="a" label={`Download ${artifact.name}`} tooltip={`Download ${artifact.name}`} variant="ghost" icon={<Download size={16} />} href={apiClient.artifactDownloadUrl(taskId, artifact.id)} /></div>
    {textOpen && safeText ? <ArtifactTextPreview taskId={taskId} artifact={artifact} /> : null}
    {safeImage ? <ArtifactImageViewer taskId={taskId} artifact={artifact} open={imageOpen} onOpenChange={setImageOpen} /> : null}
  </div>;
}

function ArtifactTextPreview({ taskId, artifact }: { taskId: string; artifact: PreviewableTaskArtifact }) {
  const [text, setText] = useState<string | null>(artifact.previewText?.slice(0, MAX_TEXT_PREVIEW_CHARACTERS) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setText(artifact.previewText?.slice(0, MAX_TEXT_PREVIEW_CHARACTERS) ?? null);
    setError(null);
  }, [artifact.id, artifact.previewText]);
  useEffect(() => {
    if (artifact.previewText !== undefined && artifact.previewText !== null) return;
    let cancelled = false;
    const controller = new AbortController();
    void apiClient.downloadTaskArtifact(taskId, artifact.id, controller.signal).then(async (blob) => {
      if (blob.size > MAX_TEXT_PREVIEW_BYTES) {
        if (!cancelled) setError("Text preview is too large.");
        return;
      }
      if (classifyPreviewMediaType(artifact.mediaType) !== "text" || classifyPreviewMediaType(blob.type) !== "text") {
        if (!cancelled) setError("The downloaded file type does not match its text preview metadata. Download the file to inspect it safely.");
        return;
      }
      const value = await blob.text();
      if (!cancelled) setText(value.slice(0, MAX_TEXT_PREVIEW_CHARACTERS));
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof ApiError ? reason.message : "Text preview could not be loaded.");
    });
    return () => { cancelled = true; controller.abort(); };
  }, [artifact.id, artifact.previewText, reloadKey, taskId]);

  if (error) return <div className="mt-3"><Banner status="error" title="Preview unavailable" description={error} /><Button className="mt-3" label="Try again" onClick={() => { setError(null); setText(null); setReloadKey((key) => key + 1); }} /></div>;
  if (text === null) return <div className="mt-3 grid min-h-24 place-items-center text-secondary"><Spinner size="sm" label="Loading preview..." /></div>;
  return <pre className="mt-3 max-h-64 overflow-auto border border-border bg-muted p-3 text-primary"><Text type="code">{text}</Text></pre>;
}

function ArtifactImageViewer({ taskId, artifact, open, onOpenChange }: { taskId: string; artifact: PreviewableTaskArtifact; open: boolean; onOpenChange: (open: boolean) => void }) {
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
      if (blob.size > MAX_IMAGE_PREVIEW_BYTES) { setError("Image preview is too large."); return; }
      if (classifyPreviewMediaType(artifact.mediaType) !== "image" || classifyPreviewMediaType(blob.type) !== "image") {
        setError("The downloaded file type does not match its image preview metadata. Download the file to inspect it safely.");
        return;
      }
      const nextUrl = URL.createObjectURL(blob);
      if (cancelled) { URL.revokeObjectURL(nextUrl); return; }
      setUrl(nextUrl);
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

  return <Dialog isOpen={open} onOpenChange={close} purpose="info" width="min(34rem, calc(100vw - 2rem))" maxHeight="min(48rem, calc(100dvh - 2rem))" aria-label={artifact.name}><Layout defaultHasDividers header={<DialogHeader title={artifact.name} subtitle={`${formatArtifactBytes(artifact.bytes)} · ${artifact.mediaType}`} onOpenChange={close} />} content={<LayoutContent padding={0}>{loading ? <div className="grid min-h-64 place-items-center text-secondary"><Spinner label="Loading image..." /></div> : null}{error ? <div className="p-5"><Banner status="error" title="Image preview unavailable" description={error} /><Button className="mt-4" label="Try again" onClick={() => { setError(null); setUrl(null); setReloadKey((key) => key + 1); }} /></div> : null}{url ? <img src={url} alt={artifact.name} className="mx-auto block max-h-[70dvh] max-w-full object-contain p-5" /> : null}</LayoutContent>} footer={<LayoutFooter><div className="flex justify-end"><Button label="Close" variant="ghost" onClick={() => close(false)} /></div></LayoutFooter>} /></Dialog>;
}
