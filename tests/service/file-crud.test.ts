import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FileService, readRegularFileWithoutFollowingSymlink } from "../../packages/application/src/fileService.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import { MAX_PROJECT_FILE_BYTES } from "../../packages/domain/src/fileDefaults.js";

const LIBRARY_ROOT="libraries/library_test/home";

describe("file CRUD service", () => {
  it("uploads, lists, downloads, and deletes arbitrary Library file bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();

      const content = Uint8Array.from([0x00, 0xff, 0x41, 0x0a]);
      const uploaded = await service.uploadLibraryFile(root, LIBRARY_ROOT, {
        path: "notes/../notes/plan.md",
        bytes: content
      });
      assert.equal(uploaded.path, "notes/plan.md");
      assert.deepEqual([...await readFile(path.join(root, LIBRARY_ROOT, "notes", "plan.md"))], [...content]);
      await assert.rejects(
        () => service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "notes/plan.md", bytes: Buffer.from("replacement") }),
        (error) => productError(error, 409, /already exists/)
      );

      const listed = await service.listLibraryFiles(root, LIBRARY_ROOT, "");
      assert.deepEqual(listed.entries.map((entry) => [entry.name, entry.path, entry.type]), [["notes", "notes", "directory"]]);

      const nested = await service.listLibraryFiles(root, LIBRARY_ROOT, "notes");
      assert.deepEqual(nested.entries.map((entry) => [entry.name, entry.path, entry.type, entry.size]), [["plan.md", "notes/plan.md", "file", 4]]);

      const downloaded = await service.downloadLibraryFile(root, LIBRARY_ROOT, "notes/plan.md");
      assert.equal(downloaded.path, "notes/plan.md");
      assert.equal(downloaded.filename, "plan.md");
      assert.deepEqual([...downloaded.bytes], [...content]);

      assert.deepEqual(await service.deleteLibraryFile(root, LIBRARY_ROOT, "notes/plan.md"), { deleted: true });
      assert.deepEqual((await service.listLibraryFiles(root, LIBRARY_ROOT, "notes")).entries, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects project file bytes over the explicit file limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();
      await assert.rejects(
        () => service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "too-large.bin", bytes: new Uint8Array(MAX_PROJECT_FILE_BYTES + 1) }),
        (error) => productError(error, 413, /Project file exceeds the .*byte limit/)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists file metadata without hydrating file contents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-metadata-"));
    const filePath = path.join(root, LIBRARY_ROOT, "large-notes.txt");
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "metadata only");
      await chmod(filePath, 0o000);

      const listed = await new FileService().listLibraryFiles(root, LIBRARY_ROOT);

      assert.deepEqual(listed.entries.map((entry) => [entry.name, entry.size, entry.mediaType]), [["large-notes.txt", 13, "text/plain"]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("infers SVG as non-inline image content and PNG as raster image content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-media-"));
    try {
      const service = new FileService();
      const svg = await service.uploadLibraryFile(root, LIBRARY_ROOT, {
        path: "diagram.svg",
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
      });
      const png = await service.uploadLibraryFile(root, LIBRARY_ROOT, {
        path: "preview.png",
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      });

      assert.equal(svg.mediaType, "image/svg+xml");
      assert.equal(png.mediaType, "image/png");
      assert.deepEqual(
        (await service.listLibraryFiles(root, LIBRARY_ROOT)).entries.map((entry) => [entry.name, entry.mediaType]),
        [
          ["diagram.svg", "image/svg+xml"],
          ["preview.png", "image/png"]
        ]
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit canonical Library root and rejects unsafe relative paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();

      await assert.rejects(
        () => service.uploadLibraryFile(root, "files", { path: "notes/plan.md", bytes: new Uint8Array() }),
        /File Library root path is invalid/
      );
      await assert.rejects(
        () => service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "../files/plan.md", bytes: new Uint8Array() }),
        /Path traversal is not allowed/
      );
      await assert.rejects(
        () => service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "files\\plan.md", bytes: new Uint8Array() }),
        /Backslash paths are not allowed/
      );
      await assert.rejects(
        () => service.deleteLibraryFile(root, LIBRARY_ROOT, ""),
        (error) => productError(error, 400, /Cannot delete the File Library root/)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects directory downloads and only deletes regular files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();
      await mkdir(path.join(root, LIBRARY_ROOT, "notes"), { recursive: true });

      await assert.rejects(
        () => service.downloadLibraryFile(root, LIBRARY_ROOT, "notes"),
        (error) => productError(error, 400, /Path is a directory/)
      );
      await assert.rejects(
        () => service.deleteLibraryFile(root, LIBRARY_ROOT, "notes"),
        (error) => productError(error, 400, /Path is not a regular file/)
      );
      await assert.rejects(
        () => service.deleteLibraryFile(root, LIBRARY_ROOT, "missing.txt"),
        (error) => productError(error, 404, /File not found/)
      );
      await assert.rejects(
        () => service.deleteLibraryFile(root, LIBRARY_ROOT, ""),
        (error) => productError(error, 400, /Cannot delete the File Library root/)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps malformed intermediate file paths to product errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();
      await mkdir(path.join(root, LIBRARY_ROOT), { recursive: true });
      await writeFile(path.join(root, LIBRARY_ROOT, "plain.txt"), "not a directory");

      await assert.rejects(
        () => service.listLibraryFiles(root, LIBRARY_ROOT, "plain.txt/child"),
        (error) => productError(error, 400, /Path is not a directory/)
      );
      await assert.rejects(
        () => service.downloadLibraryFile(root, LIBRARY_ROOT, "plain.txt/child.txt"),
        (error) => productError(error, 400, /Path is not a directory/)
      );
      await assert.rejects(
        () => service.deleteLibraryFile(root, LIBRARY_ROOT, "plain.txt/child.txt"),
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
      await mkdir(path.join(root, LIBRARY_ROOT),{recursive:true});
      await mkdir(path.join(root, LIBRARY_ROOT, "safe"));
      await writeFile(path.join(root, LIBRARY_ROOT, "safe", "ok.txt"), "ok");
      await writeFile(path.join(outside, "secret.txt"), "nope");
      await symlink(outside, path.join(root, LIBRARY_ROOT, "escape"));
      await symlink(path.join(outside,"secret.txt"),path.join(root,LIBRARY_ROOT,"secret-link.txt"));

      const service = new FileService();
      const listed = await service.listLibraryFiles(root, LIBRARY_ROOT, "");
      assert.deepEqual(listed.entries.map((entry) => entry.path), ["safe"]);
      await assert.rejects(
        () => readRegularFileWithoutFollowingSymlink(path.join(root,LIBRARY_ROOT,"secret-link.txt"),"Project file"),
        /Project file uses a symlink/
      );

      await assert.rejects(
        () => service.downloadLibraryFile(root, LIBRARY_ROOT, "escape/secret.txt"),
        /Path escapes the project root/
      );
      await assert.rejects(
        () => service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "escape/new.txt", bytes: new Uint8Array() }),
        /Path escapes the project root/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects deletion through a symlink parent inside Library files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      await mkdir(path.join(root, LIBRARY_ROOT, "safe"), { recursive: true });
      const targetPath = path.join(root, LIBRARY_ROOT, "safe", "target.txt");
      await writeFile(targetPath, "keep me");
      await symlink(path.join(root, LIBRARY_ROOT, "safe"), path.join(root, LIBRARY_ROOT, "link"));

      const service = new FileService();
      await assert.rejects(
        () => service.deleteLibraryFile(root, LIBRARY_ROOT, "link/target.txt"),
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
      const target = path.join(root, LIBRARY_ROOT, "snapshot.txt");
      const previous = Buffer.alloc(1024 * 1024, "a");
      const replacement = Buffer.alloc(8 * 1024 * 1024, "b");
      await service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "snapshot.txt", bytes: previous });

      let complete = false;
      const upload = service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "snapshot.txt", bytes: replacement, overwrite: true }).finally(() => {
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
      await service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "locked.txt", bytes: Buffer.from("before") });
      await assert.rejects(
        () => service.uploadLibraryFileWithAccounting(root, LIBRARY_ROOT, { path: "locked.txt", bytes: Buffer.from("after"), overwrite: true }, {
          record: async () => { throw new ProductError("Project file bytes limit reached", 409); }
        }),
        /project file bytes limit reached/i
      );
      assert.equal(Buffer.from((await service.downloadLibraryFile(root, LIBRARY_ROOT, "locked.txt")).bytes).toString(), "before");
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
      const upload = service.uploadLibraryFileWithAccounting(root, LIBRARY_ROOT, { path: "rejected.txt", bytes: Buffer.from("temporary") }, {
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
      const listed = service.listLibraryFiles(root, LIBRARY_ROOT).finally(() => {
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
        service.uploadLibraryFileWithAccounting(root, LIBRARY_ROOT, { path: "one.txt", bytes: Buffer.from("four") }, accounting),
        service.uploadLibraryFileWithAccounting(root, LIBRARY_ROOT, { path: "two.txt", bytes: Buffer.from("four") }, accounting)
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(used, 4);
      assert.equal((await service.listLibraryFiles(root, LIBRARY_ROOT)).entries.filter((entry) => entry.type === "file").length, 1);
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
      await service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "unaccounted.txt", bytes: Buffer.from("four") });
      await service.uploadLibraryFileWithAccounting(root, LIBRARY_ROOT, { path: "next.txt", bytes: Buffer.from("ok") }, {
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
