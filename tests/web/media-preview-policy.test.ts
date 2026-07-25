import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPreviewMediaType } from "../../packages/contracts/src/api.js";
import {
  createInlinePreviewRequest,
  inlinePreviewPolicy,
  isInlinePreviewAvailable
} from "../../src/components/media/inline-preview.js";

describe("inline media preview policy", () => {
  it("classifies only the supported text and raster image media types", () => {
    for (const mediaType of [
      "text/plain",
      "text/csv",
      "text/markdown",
      "application/json"
    ]) {
      assert.equal(classifyPreviewMediaType(mediaType), "text", mediaType);
    }

    for (const mediaType of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp"
    ]) {
      assert.equal(classifyPreviewMediaType(mediaType), "image", mediaType);
    }
  });

  it("normalizes safe MIME casing, whitespace, and parameters", () => {
    assert.equal(classifyPreviewMediaType("  TEXT/PLAIN ; charset=UTF-8  "), "text");
    assert.equal(classifyPreviewMediaType("Image/PNG; name=preview.png"), "image");
  });

  it("never lets parameters disguise a dangerous or unsupported media type", () => {
    for (const mediaType of [
      "image/svg+xml",
      "image/svg+xml; type=image/png",
      "text/html",
      "text/html; charset=utf-8; type=text/plain",
      "application/xml",
      "application/xml; type=application/json",
      "application/octet-stream",
      "image/avif",
      "unknown/unknown",
      "image/png, image/svg+xml",
      "",
      null,
      undefined
    ]) {
      assert.equal(classifyPreviewMediaType(mediaType), null, String(mediaType));
    }
  });

  it("uses one bounded policy for text and raster image previews", () => {
    assert.deepEqual(inlinePreviewPolicy("text/plain"), {
      kind: "text",
      maxBytes: 512 * 1024,
      maxCharacters: 16_000
    });
    assert.deepEqual(inlinePreviewPolicy("image/png"), {
      kind: "image",
      maxBytes: 8 * 1024 * 1024
    });
    assert.equal(inlinePreviewPolicy("image/svg+xml"), null);

    assert.equal(isInlinePreviewAvailable({ mediaType: "image/png", bytes: 8 * 1024 * 1024 }), true);
    assert.equal(isInlinePreviewAvailable({ mediaType: "image/png", bytes: 8 * 1024 * 1024 + 1 }), false);
    assert.equal(isInlinePreviewAvailable({ mediaType: "text/plain", bytes: 600_000, previewText: "bounded excerpt" }), true);
  });

  it("validates the response MIME and truncates text through the shared request", async () => {
    let receivedSignal: AbortSignal | undefined;
    const request = createInlinePreviewRequest({
      mediaType: "text/plain",
      bytes: 20_000,
      load: async (signal) => {
        receivedSignal = signal;
        return new Blob(["a".repeat(20_000)], { type: "text/plain; charset=utf-8" });
      }
    });

    assert.deepEqual(await request.result, { kind: "text", text: "a".repeat(16_000) });
    assert.equal(receivedSignal, request.signal);
    request.dispose();
    assert.equal(request.signal.aborted, true);

    const mismatched = createInlinePreviewRequest({
      mediaType: "image/png",
      bytes: 10,
      load: async () => new Blob(["not an image"], { type: "text/plain" })
    });
    await assert.rejects(mismatched.result, /does not match its preview metadata/i);
    mismatched.dispose();

    let loadedExcerpt = false;
    const excerpt = createInlinePreviewRequest({
      mediaType: "text/markdown",
      bytes: 900_000,
      previewText: "b".repeat(20_000),
      load: async () => {
        loadedExcerpt = true;
        return new Blob();
      }
    });
    assert.deepEqual(await excerpt.result, { kind: "text", text: "b".repeat(16_000) });
    assert.equal(loadedExcerpt, false);
    excerpt.dispose();

    const oversizedResponse = createInlinePreviewRequest({
      mediaType: "text/plain",
      bytes: 1,
      load: async () => new Blob([new Uint8Array(512 * 1024 + 1)], { type: "text/plain" })
    });
    await assert.rejects(oversizedResponse.result, /too large to preview/i);
    oversizedResponse.dispose();
  });

  it("owns Blob URL cleanup and aborts pending loads when disposed", async () => {
    const revoked: string[] = [];
    const image = createInlinePreviewRequest({
      mediaType: "image/png",
      bytes: 4,
      load: async () => new Blob([Uint8Array.of(137, 80, 78, 71)], { type: "image/png" }),
      objectUrls: {
        create: () => "blob:preview",
        revoke: (url) => revoked.push(url)
      }
    });

    assert.deepEqual(await image.result, { kind: "image", url: "blob:preview" });
    image.dispose();
    image.dispose();
    assert.deepEqual(revoked, ["blob:preview"]);
    assert.equal(image.signal.aborted, true);

    const pending = createInlinePreviewRequest({
      mediaType: "text/plain",
      bytes: 1,
      load: (signal) => new Promise<Blob>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
    });
    pending.dispose();
    await assert.rejects(pending.result, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  });
});
