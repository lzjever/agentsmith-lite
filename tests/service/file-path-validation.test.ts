import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FilePathValidationService } from "../../packages/application/src/filePathValidationService.js";

describe("file path validation", () => {
  it("normalizes safe project paths and rejects traversal or absolute paths", async () => {
    const service = new FilePathValidationService();
    assert.equal(service.normalizeRelativeProjectPath("files/notes/../plan.md"), "files/plan.md");

    assert.throws(() => service.normalizeRelativeProjectPath("../outside.txt"), /Path traversal is not allowed/);
    assert.throws(() => service.normalizeRelativeProjectPath("/etc/passwd"), /Absolute paths are not allowed/);
    assert.throws(() => service.normalizeRelativeProjectPath("files\\secret.txt"), /Backslash paths are not allowed/);
  });

  it("rejects symlink escapes when resolving under a project root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "asl-outside-"));
    try {
      await mkdir(path.join(root, "files"));
      await writeFile(path.join(outside, "secret.txt"), "nope");
      await symlink(outside, path.join(root, "files", "escape"));

      const service = new FilePathValidationService();
      await assert.rejects(
        () => service.resolveSafeProjectPath(root, "files/escape/secret.txt"),
        /Path escapes the project root/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

