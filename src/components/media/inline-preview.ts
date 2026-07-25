import { classifyPreviewMediaType } from "../../../packages/contracts/src/api.js";

const textPolicy = {
  kind: "text",
  maxBytes: 512 * 1024,
  maxCharacters: 16_000
} as const;

const imagePolicy = {
  kind: "image",
  maxBytes: 8 * 1024 * 1024
} as const;

export type InlinePreviewPolicy = typeof textPolicy | typeof imagePolicy;
export type InlinePreviewContent =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string };

type PreviewMetadata = {
  mediaType?: string | null | undefined;
  bytes: number;
  previewText?: string | null | undefined;
};

type InlinePreviewRequestOptions = PreviewMetadata & {
  load: (signal: AbortSignal) => Promise<Blob>;
  objectUrls?: {
    create: (blob: Blob) => string;
    revoke: (url: string) => void;
  };
};

export type InlinePreviewRequest = {
  signal: AbortSignal;
  result: Promise<InlinePreviewContent>;
  dispose: () => void;
};

export function inlinePreviewPolicy(mediaType: string | null | undefined): InlinePreviewPolicy | null {
  const kind = classifyPreviewMediaType(mediaType);
  return kind === "text" ? textPolicy : kind === "image" ? imagePolicy : null;
}

export function isInlinePreviewAvailable(metadata: PreviewMetadata): boolean {
  const policy = inlinePreviewPolicy(metadata.mediaType);
  if (!policy || !Number.isFinite(metadata.bytes) || metadata.bytes < 0) return false;
  return policy.kind === "text" && metadata.previewText != null
    ? true
    : metadata.bytes <= policy.maxBytes;
}

export function createInlinePreviewRequest(options: InlinePreviewRequestOptions): InlinePreviewRequest {
  const controller = new AbortController();
  const objectUrls = options.objectUrls ?? {
    create: (blob: Blob) => URL.createObjectURL(blob),
    revoke: (url: string) => URL.revokeObjectURL(url)
  };
  let objectUrl: string | null = null;
  let disposed = false;

  function releaseObjectUrl() {
    if (!objectUrl) return;
    objectUrls.revoke(objectUrl);
    objectUrl = null;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    releaseObjectUrl();
  }

  const result = resolveInlinePreview(options, controller.signal, (blob) => {
    const createdUrl = objectUrls.create(blob);
    objectUrl = createdUrl;
    if (disposed) {
      releaseObjectUrl();
      controller.signal.throwIfAborted();
    }
    return createdUrl;
  });

  return { signal: controller.signal, result, dispose };
}

async function resolveInlinePreview(
  options: InlinePreviewRequestOptions,
  signal: AbortSignal,
  createObjectUrl: (blob: Blob) => string
): Promise<InlinePreviewContent> {
  signal.throwIfAborted();
  const policy = inlinePreviewPolicy(options.mediaType);
  if (!policy) throw new Error("This file type cannot be previewed safely.");

  if (policy.kind === "text" && options.previewText != null) {
    return { kind: "text", text: options.previewText.slice(0, policy.maxCharacters) };
  }
  if (!isInlinePreviewAvailable(options)) {
    throw new Error("This file is too large to preview. Download it to inspect the complete content.");
  }

  const blob = await options.load(signal);
  signal.throwIfAborted();
  const responsePolicy = inlinePreviewPolicy(blob.type);
  if (!responsePolicy || responsePolicy.kind !== policy.kind) {
    throw new Error("The downloaded file type does not match its preview metadata. Download the file to inspect it safely.");
  }
  if (blob.size > policy.maxBytes) {
    throw new Error("This file is too large to preview. Download it to inspect the complete content.");
  }

  if (policy.kind === "text") {
    const text = await blob.text();
    signal.throwIfAborted();
    return { kind: "text", text: text.slice(0, policy.maxCharacters) };
  }
  return { kind: "image", url: createObjectUrl(blob) };
}
