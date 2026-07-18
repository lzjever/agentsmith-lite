import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FileService, readRegularFileWithoutFollowingSymlink } from "../../packages/application/src/fileService.js";
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
      await assert.rejects(
        () => service.uploadFile(root, { path: "files/notes/plan.md", bytes: Buffer.from("replacement") }),
        (error) => productError(error, 409, /already exists/)
      );

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

  it("lists file metadata without hydrating file contents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-metadata-"));
    const filePath = path.join(root, "files", "large-notes.txt");
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "metadata only");
      await chmod(filePath, 0o000);

      const listed = await new FileService().listFiles(root);

      assert.deepEqual(listed.entries.map((entry) => [entry.name, entry.size, entry.mediaType]), [["large-notes.txt", 13, "text/plain"]]);
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
      await symlink(path.join(outside,"secret.txt"),path.join(root,"files","secret-link.txt"));

      const service = new FileService();
      const listed = await service.listFiles(root, "files");
      assert.deepEqual(listed.entries.map((entry) => entry.path), ["files/safe"]);
      await assert.rejects(
        () => readRegularFileWithoutFollowingSymlink(path.join(root,"files","secret-link.txt"),"Project file"),
        /Project file uses a symlink/
      );

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

  it("atomically replaces uploads so concurrent reads see a complete old or new file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();
      const target = path.join(root, "files", "snapshot.txt");
      const previous = Buffer.alloc(1024 * 1024, "a");
      const replacement = Buffer.alloc(8 * 1024 * 1024, "b");
      await service.uploadFile(root, { path: "files/snapshot.txt", bytes: previous });

      let complete = false;
      const upload = service.uploadFile(root, { path: "files/snapshot.txt", bytes: replacement, overwrite: true }).finally(() => {
        complete = true;
      });
      while (!complete) {
        const bytes = await readFile(target);
        assert.ok(bytes.equals(previous) || bytes.equals(replacement));
      }
      await upload;
      assert.deepEqual(await readFile(target), replacement);
      assert.deepEqual(await readdir(path.dirname(target)), ["snapshot.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores the previous file when locked byte accounting rejects an overwrite", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-accounting-"));
    const service = new FileService();
    try {
      await service.uploadFile(root, { path: "files/locked.txt", bytes: Buffer.from("before") });
      await assert.rejects(
        () => service.uploadFileWithAccounting(root, { path: "files/locked.txt", bytes: Buffer.from("after"), overwrite: true }, {
          record: async () => { throw new ProductError("Project file bytes limit reached", 409); }
        }),
        /project file bytes limit reached/i
      );
      assert.equal(Buffer.from((await service.downloadFile(root, "files/locked.txt")).bytes).toString(), "before");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not list an upload before its byte accounting commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-list-consistency-"));
    const service = new FileService();
    let releaseAccounting!: () => void;
    const accountingBlocked = new Promise<void>((resolve) => {
      releaseAccounting = resolve;
    });
    let accountingStarted!: () => void;
    const accountingEntered = new Promise<void>((resolve) => {
      accountingStarted = resolve;
    });
    try {
      const upload = service.uploadFileWithAccounting(root, { path: "files/rejected.txt", bytes: Buffer.from("temporary") }, {
        record: async () => {
          accountingStarted();
          await accountingBlocked;
          throw new ProductError("Project file bytes limit reached", 409);
        }
      }).then(
        () => null,
        (error: unknown) => error
      );
      await accountingEntered;

      let listCompleted = false;
      const listed = service.listFiles(root).finally(() => {
        listCompleted = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(listCompleted, false);

      releaseAccounting();
      assert.match(String(await upload), /Project file bytes limit reached/);
      assert.deepEqual((await listed).entries, []);
    } finally {
      releaseAccounting();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent charged uploads so rejected quota writes leave no file behind", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-concurrent-accounting-"));
    const service = new FileService();
    let used = 0;
    const accounting = {
      async record(_path: string, delta: number) {
        if (used + delta > 4) throw new ProductError("Project file bytes limit reached", 409);
        used += delta;
      }
    };
    try {
      const results = await Promise.allSettled([
        service.uploadFileWithAccounting(root, { path: "files/one.txt", bytes: Buffer.from("four") }, accounting),
        service.uploadFileWithAccounting(root, { path: "files/two.txt", bytes: Buffer.from("four") }, accounting)
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(used, 4);
      assert.equal((await service.listFiles(root)).entries.filter((entry) => entry.type === "file").length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles files left behind before admitting the next charged upload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-reconcile-"));
    const service = new FileService();
    let used = 0;
    const reconciled: number[] = [];
    try {
      await service.uploadFile(root, { path: "files/unaccounted.txt", bytes: Buffer.from("four") });
      await service.uploadFileWithAccounting(root, { path: "files/next.txt", bytes: Buffer.from("ok") }, {
        async reconcile(bytes) {
          reconciled.push(bytes);
          used = bytes;
        },
        async record(_path, delta) {
          if (used + delta > 6) throw new ProductError("Project file bytes limit reached", 409);
          used += delta;
        }
      });

      assert.deepEqual(reconciled, [4]);
      assert.equal(used, 6);
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
