import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FileService } from "../../packages/application/src/fileService.js";

describe("file CRUD service", () => {
  it("uploads, lists, downloads, and deletes UTF-8 project files under files/", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();

      const uploaded = await service.uploadTextFile(root, {
        path: "files/notes/../notes/plan.md",
        content: "hello from files"
      });
      assert.equal(uploaded.path, "files/notes/plan.md");
      assert.equal(await readFile(path.join(root, "files", "notes", "plan.md"), "utf8"), "hello from files");

      const listed = await service.listFiles(root, "files");
      assert.deepEqual(listed.entries.map((entry) => [entry.path, entry.type]), [["files/notes", "directory"]]);

      const nested = await service.listFiles(root, "files/notes");
      assert.deepEqual(nested.entries.map((entry) => [entry.path, entry.type, entry.size]), [["files/notes/plan.md", "file", 16]]);

      const downloaded = await service.downloadTextFile(root, "files/notes/plan.md");
      assert.deepEqual(downloaded, { path: "files/notes/plan.md", content: "hello from files" });

      assert.deepEqual(await service.deleteFile(root, "files/notes/plan.md"), { deleted: true });
      assert.deepEqual((await service.listFiles(root, "files/notes")).entries, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects paths outside the files/ subtree and protected roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();

      await assert.rejects(
        () => service.uploadTextFile(root, { path: "notes/plan.md", content: "nope" }),
        /Project files must be under files\//
      );
      await assert.rejects(
        () => service.uploadTextFile(root, { path: "../files/plan.md", content: "nope" }),
        /Path traversal is not allowed/
      );
      await assert.rejects(
        () => service.uploadTextFile(root, { path: "files\\plan.md", content: "nope" }),
        /Backslash paths are not allowed/
      );
      await assert.rejects(
        () => service.deleteFile(root, "files"),
        /Cannot delete the files root/
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
        () => service.downloadTextFile(root, "files/escape/secret.txt"),
        /Path escapes the project root/
      );
      await assert.rejects(
        () => service.uploadTextFile(root, { path: "files/escape/new.txt", content: "nope" }),
        /Path escapes the project root/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
