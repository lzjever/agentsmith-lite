import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FileService } from "../../packages/application/src/fileService.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import { MAX_PROJECT_FILE_BYTES } from "../../packages/domain/src/fileDefaults.js";

describe("file CRUD service", () => {
  it("uploads, lists, downloads, and deletes arbitrary project file bytes under files/", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();

      const content = Uint8Array.from([0x00, 0xff, 0x41, 0x0a]);
      const uploaded = await service.uploadFile(root, {
        path: "files/notes/../notes/plan.md",
        bytes: content
      });
      assert.equal(uploaded.path, "files/notes/plan.md");
      assert.deepEqual([...await readFile(path.join(root, "files", "notes", "plan.md"))], [...content]);

      const listed = await service.listFiles(root, "files");
      assert.deepEqual(listed.entries.map((entry) => [entry.name, entry.path, entry.type]), [["notes", "files/notes", "directory"]]);

      const nested = await service.listFiles(root, "files/notes");
      assert.deepEqual(nested.entries.map((entry) => [entry.name, entry.path, entry.type, entry.size]), [["plan.md", "files/notes/plan.md", "file", 4]]);

      const downloaded = await service.downloadFile(root, "files/notes/plan.md");
      assert.equal(downloaded.path, "files/notes/plan.md");
      assert.equal(downloaded.filename, "plan.md");
      assert.deepEqual([...downloaded.bytes], [...content]);

      assert.deepEqual(await service.deleteFile(root, "files/notes/plan.md"), { deleted: true });
      assert.deepEqual((await service.listFiles(root, "files/notes")).entries, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects project file bytes over the explicit file limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();
      await assert.rejects(
        () => service.uploadFile(root, { path: "files/too-large.bin", bytes: new Uint8Array(MAX_PROJECT_FILE_BYTES + 1) }),
        (error) => productError(error, 413, /Project file exceeds the .*byte limit/)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects paths outside the files/ subtree and protected roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();

      await assert.rejects(
        () => service.uploadFile(root, { path: "notes/plan.md", bytes: new Uint8Array() }),
        /Project files must be under files\//
      );
      await assert.rejects(
        () => service.uploadFile(root, { path: "../files/plan.md", bytes: new Uint8Array() }),
        /Path traversal is not allowed/
      );
      await assert.rejects(
        () => service.uploadFile(root, { path: "files\\plan.md", bytes: new Uint8Array() }),
        /Backslash paths are not allowed/
      );
      await assert.rejects(
        () => service.deleteFile(root, "files"),
        (error) => productError(error, 400, /Cannot delete the files root/)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects directory downloads and only deletes regular files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();
      await mkdir(path.join(root, "files", "notes"), { recursive: true });

      await assert.rejects(
        () => service.downloadFile(root, "files/notes"),
        (error) => productError(error, 400, /Path is a directory/)
      );
      await assert.rejects(
        () => service.deleteFile(root, "files/notes"),
        (error) => productError(error, 400, /Path is not a regular file/)
      );
      await assert.rejects(
        () => service.deleteFile(root, "files/missing.txt"),
        (error) => productError(error, 404, /File not found/)
      );
      await assert.rejects(
        () => service.deleteFile(root, "files"),
        (error) => productError(error, 400, /Cannot delete the files root/)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps malformed intermediate file paths to product errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();
      await mkdir(path.join(root, "files"), { recursive: true });
      await writeFile(path.join(root, "files", "plain.txt"), "not a directory");

      await assert.rejects(
        () => service.listFiles(root, "files/plain.txt/child"),
        (error) => productError(error, 400, /Path is not a directory/)
      );
      await assert.rejects(
        () => service.downloadFile(root, "files/plain.txt/child.txt"),
        (error) => productError(error, 400, /Path is not a directory/)
      );
      await assert.rejects(
        () => service.deleteFile(root, "files/plain.txt/child.txt"),
        (error) => productError(error, 400, /Path is not a directory/)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow symlinks while listing and rejects symlink escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    const outside = await mkdtemp(path.join(tmpdir(), "asl-outside-"));
    try {
      await mkdir(path.join(root, "files"));
      await mkdir(path.join(root, "files", "safe"));
      await writeFile(path.join(root, "files", "safe", "ok.txt"), "ok");
      await writeFile(path.join(outside, "secret.txt"), "nope");
      await symlink(outside, path.join(root, "files", "escape"));

      const service = new FileService();
      const listed = await service.listFiles(root, "files");
      assert.deepEqual(listed.entries.map((entry) => entry.path), ["files/safe"]);

      await assert.rejects(
        () => service.downloadFile(root, "files/escape/secret.txt"),
        /Path escapes the project root/
      );
      await assert.rejects(
        () => service.uploadFile(root, { path: "files/escape/new.txt", bytes: new Uint8Array() }),
        /Path escapes the project root/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects deletion through a symlink parent inside project files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      await mkdir(path.join(root, "files", "safe"), { recursive: true });
      const targetPath = path.join(root, "files", "safe", "target.txt");
      await writeFile(targetPath, "keep me");
      await symlink(path.join(root, "files", "safe"), path.join(root, "files", "link"));

      const service = new FileService();
      await assert.rejects(
        () => service.deleteFile(root, "files/link/target.txt"),
        (error) => productError(error, 400, /Path uses a symlink/)
      );
      assert.equal(await readFile(targetPath, "utf8"), "keep me");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function productError(error: unknown, statusCode: number, message: RegExp): boolean {
  assert.ok(error instanceof ProductError);
  assert.equal(error.statusCode, statusCode);
  assert.match(error.message, message);
  return true;
}
