import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPreviewMediaType } from "../../packages/contracts/src/api.js";

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
});
