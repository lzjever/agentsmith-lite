import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { DescriptorFileTreeWalker } from "../../packages/application/src/descriptorFileTreeWalker.js";
import { FileService, readRegularFileWithoutFollowingSymlink } from "../../packages/application/src/fileService.js";
import { FilePathValidationService } from "../../packages/application/src/filePathValidationService.js";
import { RecursiveDeletionService, TransientFileDeletionOperationStore } from "../../packages/application/src/recursiveDeletionService.js";
import { ProductError } from "../../packages/domain/src/errors.js";
import { MAX_PROJECT_FILE_BYTES } from "../../packages/domain/src/fileDefaults.js";
import type { FileDeletionOperationOwner, FileDeletionOperationState } from "../../packages/ports/src/store.js";

const LIBRARY_ROOT="libraries/library_test/home";
const execFileAsync = promisify(execFile);

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

  it("returns typed missing-folder errors instead of empty listings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-missing-folder-"));
    try {
      const service = new FileService();
      await service.ensureLibraryRoot(root, LIBRARY_ROOT);

      await assert.rejects(
        () => service.listLibraryFiles(root, LIBRARY_ROOT, "removed"),
        (error) => {
          assert.ok(error instanceof ProductError);
          assert.equal(error.statusCode, 404);
          assert.equal(error.code, "file_path_not_found");
          return true;
        }
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters the Artifact namespace and projects server-owned delete capability", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-artifact-policy-"));
    try {
      const service = new FileService();
      await mkdir(path.join(root, LIBRARY_ROOT, "workspace", ".artifacts"), { recursive: true });
      await writeFile(path.join(root, LIBRARY_ROOT, "workspace", ".artifacts", "owned.txt"), "artifact");
      await writeFile(path.join(root, LIBRARY_ROOT, "workspace", "notes.txt"), "notes");

      const rootListing = await service.listLibraryFiles(root, LIBRARY_ROOT);
      assert.deepEqual(rootListing.entries.map((entry) => ({
        path: entry.path,
        capabilities: entry.capabilities
      })), [{
        path: "workspace",
        capabilities: {
          canDelete: false,
          deleteUnavailableReason: "artifact_namespace_protected"
        }
      }]);

      const workspaceListing = await service.listLibraryFiles(root, LIBRARY_ROOT, "workspace");
      assert.deepEqual(workspaceListing.entries.map((entry) => ({
        path: entry.path,
        capabilities: entry.capabilities
      })), [{
        path: "workspace/notes.txt",
        capabilities: {
          canDelete: true,
          deleteUnavailableReason: null
        }
      }]);

      const readOnlyListing = await service.listLibraryFiles(root, LIBRARY_ROOT, "workspace", false);
      assert.deepEqual(readOnlyListing.entries[0]?.capabilities, {
        canDelete: false,
        deleteUnavailableReason: "read_only"
      });

      for (const action of [
        () => service.listLibraryFiles(root, LIBRARY_ROOT, "workspace/.artifacts"),
        () => service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "workspace/.artifacts/new.txt", bytes: Buffer.from("no") }),
        () => service.downloadLibraryFile(root, LIBRARY_ROOT, "workspace/.artifacts/owned.txt"),
        () => service.deleteLibraryFile(root, LIBRARY_ROOT, "workspace/.artifacts/owned.txt"),
        () => service.deleteLibraryFile(root, LIBRARY_ROOT, "workspace")
      ]) {
        await assert.rejects(action, (error) => {
          assert.ok(error instanceof ProductError);
          assert.equal(error.code, "artifact_namespace_protected");
          return true;
        });
      }
      assert.equal(await readFile(path.join(root, LIBRARY_ROOT, "workspace", ".artifacts", "owned.txt"), "utf8"), "artifact");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects directory downloads and recursively deletes observed directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-"));
    try {
      const service = new FileService();
      await mkdir(path.join(root, LIBRARY_ROOT, "notes", "nested"), { recursive: true });
      await writeFile(path.join(root, LIBRARY_ROOT, "notes", "first.txt"), "one");
      await writeFile(path.join(root, LIBRARY_ROOT, "notes", "nested", "second.txt"), "two");

      await assert.rejects(
        () => service.downloadLibraryFile(root, LIBRARY_ROOT, "notes"),
        (error) => productError(error, 400, /Path is a directory/)
      );
      assert.deepEqual(await service.deleteLibraryFile(root, LIBRARY_ROOT, "notes"), { deleted: true });
      assert.deepEqual((await service.listLibraryFiles(root, LIBRARY_ROOT)).entries, []);
      await assert.rejects(
        () => service.deleteLibraryFile(root, LIBRARY_ROOT, "missing.txt"),
        (error) => productError(error, 404, /File path not found/)
      );
      await assert.rejects(
        () => service.deleteLibraryFile(root, LIBRARY_ROOT, ""),
        (error) => productError(error, 400, /Cannot delete the File Library root/)
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates recursive deletion before complete remaining-byte accounting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-recursive-accounting-"));
    const service = new FileService();
    const reconciled: number[] = [];
    const recorded: Array<{ path: string; delta: number; bytes: number; entryType: string | undefined }> = [];
    try {
      await service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "selected/first.txt", bytes: Buffer.from("one") });
      await service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "selected/nested/second.txt", bytes: Buffer.from("two") });
      await service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "keep.txt", bytes: Buffer.from("keep") });

      await service.deleteLibraryFileWithAccounting(root, LIBRARY_ROOT, "selected", {
        rootSubPaths: [LIBRARY_ROOT],
        async reconcile(bytes) {
          reconciled.push(bytes);
          await assert.rejects(readFile(path.join(root, LIBRARY_ROOT, "selected", "first.txt")));
          const operationDirectories = await readdir(path.join(root, ".deletions"));
          assert.equal(operationDirectories.length, 1);
          assert.equal(await readFile(path.join(root, ".deletions", operationDirectories[0]!, "entry", "first.txt"), "utf8"), "one");
        },
        async record(deletedPath, delta, entry) {
          recorded.push({ path: deletedPath, delta, bytes: entry.bytes, entryType: entry.entryType });
        }
      });

      assert.deepEqual(reconciled, [4]);
      assert.deepEqual(recorded, [{ path: "selected", delta: -6, bytes: 6, entryType: "directory" }]);
      assert.deepEqual((await service.listLibraryFiles(root, LIBRARY_ROOT)).entries.map((entry) => entry.path), ["keep.txt"]);
      assert.deepEqual(await readdir(path.join(root, ".deletions")), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("measures remaining roots without following a directory replaced by a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-measure-race-"));
    const outside = await mkdtemp(path.join(tmpdir(), "asl-files-measure-race-outside-"));
    const nested = path.join(root, LIBRARY_ROOT, "nested");
    let substituted = false;
    const walker = new DescriptorFileTreeWalker({
      async beforeOpenEntry(event) {
        if (event.purpose !== "measure" || event.name !== "nested" || substituted) return;
        substituted = true;
        await rm(nested, { recursive: true });
        await symlink(outside, nested);
      }
    });
    try {
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(nested, "local.txt"), "local");
      await writeFile(path.join(root, LIBRARY_ROOT, "retained.txt"), "kept");
      await writeFile(path.join(outside, "outside.txt"), "must-not-count");

      const service = new FileService(new FilePathValidationService(), walker);
      assert.equal(await service.measureFileRootsBytes(root, [LIBRARY_ROOT]), 4);
      assert.equal(substituted, true);
      assert.equal(await readFile(path.join(outside, "outside.txt"), "utf8"), "must-not-count");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("resumes the same isolated operation after accounting fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-delete-resume-"));
    const service = new FileService();
    const operations = new TransientFileDeletionOperationStore();
    const owner: FileDeletionOperationOwner = {
      actorId: "user_delete_resume",
      projectId: "project_delete_resume",
      operation: "project.file.delete",
      key: "delete-resume-key",
      requestHash: "delete-resume-request",
      resourceId: "file_delete_resume",
      claimToken: "delete-resume-claim"
    };
    const context = {
      owner,
      operations
    };
    let rejectAccounting = true;
    try {
      await service.uploadLibraryFile(root, LIBRARY_ROOT, { path: "selected/value.txt", bytes: Buffer.from("value") });
      const accounting = {
        rootSubPaths: [LIBRARY_ROOT],
        async reconcile() {
          if (rejectAccounting) throw new Error("accounting unavailable");
        },
        async record() {}
      };

      await assert.rejects(
        () => service.deleteLibraryFileWithAccounting(root, LIBRARY_ROOT, "selected", accounting, context),
        /accounting unavailable/
      );
      assert.equal(
        await readFile(path.join(root, ".deletions", owner.resourceId, "entry", "value.txt"), "utf8"),
        "value"
      );

      rejectAccounting = false;
      assert.deepEqual(
        (await service.deleteLibraryFileWithAccounting(root, LIBRARY_ROOT, "selected", accounting, context)).response,
        { deleted: true }
      );
      assert.deepEqual(await readdir(path.join(root, ".deletions")), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an exact quarantined entry after crashing before isolated state persistence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-rename-recovery-"));
    let state: FileDeletionOperationState | null = null;
    let rejectFirstPersistence = true;
    const owner: FileDeletionOperationOwner = {
      actorId: "user_rename_recovery",
      projectId: "project_rename_recovery",
      operation: "project.file.delete",
      key: "rename-recovery-key",
      requestHash: "rename-recovery-request",
      resourceId: "file_delete_rename_recovery",
      claimToken: "rename-recovery-claim"
    };
    const operations = {
      async findFileDeletionOperation(requestedOwner: FileDeletionOperationOwner) {
        assert.deepEqual(requestedOwner, owner);
        return state ? { ...state } : null;
      },
      async persistFileDeletionOperation(requestedOwner: FileDeletionOperationOwner, next: FileDeletionOperationState) {
        assert.deepEqual(requestedOwner, owner);
        if (rejectFirstPersistence) {
          rejectFirstPersistence = false;
          throw new Error("database unavailable after rename");
        }
        state = { ...next };
        return true;
      }
    };
    const target = {
      owner,
      projectRoot: root,
      libraryRoot: LIBRARY_ROOT,
      relativePath: "selected/target.txt",
    };
    try {
      const sourceParent = path.join(root, LIBRARY_ROOT, "selected");
      await mkdir(sourceParent, { recursive: true });
      await writeFile(path.join(sourceParent, "target.txt"), "original");

      const deletion = new RecursiveDeletionService();
      await assert.rejects(
        () => deletion.isolateEntry(target, operations),
        /database unavailable after rename/
      );
      const operationRoot = path.join(root, ".deletions", owner.resourceId);
      assert.equal(await readFile(path.join(operationRoot, "entry"), "utf8"), "original");
      assert.deepEqual(JSON.parse(await readFile(path.join(operationRoot, "operation.json"), "utf8")), {
        version: 1,
        kind: "entry",
        projectId: owner.projectId,
        libraryRoot: LIBRARY_ROOT,
        relativePath: "selected/target.txt",
        operationId: owner.resourceId,
        requestHash: owner.requestHash
      });

      await mkdir(sourceParent, { recursive: true });
      await writeFile(path.join(sourceParent, "target.txt"), "replacement");
      assert.deepEqual(await deletion.isolateEntry(target, operations), {
        operationId: owner.resourceId,
        entryType: "file",
        bytes: 8
      });
      assert.equal(await readFile(path.join(sourceParent, "target.txt"), "utf8"), "replacement");

      await deletion.removeIsolatedEntry(target, operations);
      assert.equal(await readFile(path.join(sourceParent, "target.txt"), "utf8"), "replacement");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never adopts a quarantined entry without an exact pre-existing marker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-marker-missing-"));
    const owner = deletionOwner("marker-missing");
    const operationRoot = path.join(root, ".deletions", owner.resourceId);
    let persistenceCalls = 0;
    const operations = {
      async findFileDeletionOperation() { return null; },
      async persistFileDeletionOperation() {
        persistenceCalls += 1;
        return true;
      }
    };
    try {
      await mkdir(operationRoot, { recursive: true });
      await writeFile(path.join(operationRoot, "entry"), "unowned");
      await assert.rejects(
        () => new RecursiveDeletionService().isolateEntry(deletionTarget(root, owner), operations),
        (error: unknown) => productError(error, 500, /marker is missing/, "file_deletion_incomplete")
      );
      assert.equal(persistenceCalls, 0);
      assert.equal(await readFile(path.join(operationRoot, "entry"), "utf8"), "unowned");
      await assert.rejects(readFile(path.join(operationRoot, "operation.json")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails retryably on mismatched or partial markers around a quarantined entry", async () => {
    for (const marker of [
      { name: "operation.json", content: "{\"version\":1,\"kind\":\"other\"}" },
      { name: "operation.json.pending", content: "{\"version\":" }
    ]) {
      const root = await mkdtemp(path.join(tmpdir(), `asl-files-marker-${marker.name.includes("pending") ? "partial" : "mismatch"}-`));
      const owner = deletionOwner(marker.name);
      const operationRoot = path.join(root, ".deletions", owner.resourceId);
      try {
        await mkdir(operationRoot, { recursive: true });
        await writeFile(path.join(operationRoot, "entry"), "contained");
        await writeFile(path.join(operationRoot, marker.name), marker.content);
        await assert.rejects(
          () => new RecursiveDeletionService().isolateEntry(deletionTarget(root, owner), {
            async findFileDeletionOperation() { return null; },
            async persistFileDeletionOperation() { return true; }
          }),
          (error: unknown) => productError(error, 500, /marker/, "file_deletion_incomplete")
        );
        assert.equal(await readFile(path.join(operationRoot, "entry"), "utf8"), "contained");
        assert.equal(await readFile(path.join(operationRoot, marker.name), "utf8"), marker.content);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("repairs a partial pending marker only while the operation directory is pre-rename empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-marker-repair-"));
    const owner = deletionOwner("marker-repair");
    const operationRoot = path.join(root, ".deletions", owner.resourceId);
    const source = path.join(root, LIBRARY_ROOT, "selected", "target.txt");
    const operations = new TransientFileDeletionOperationStore();
    try {
      await mkdir(operationRoot, { recursive: true });
      await writeFile(path.join(operationRoot, "operation.json.pending"), "{\"version\":");
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, "target");

      assert.deepEqual(
        await new RecursiveDeletionService().isolateEntry(deletionTarget(root, owner), operations),
        { operationId: owner.resourceId, entryType: "file", bytes: 6 }
      );
      assert.deepEqual((await readdir(operationRoot)).sort(), ["entry", "operation.json"]);
      assert.deepEqual(JSON.parse(await readFile(path.join(operationRoot, "operation.json"), "utf8")), {
        version: 1,
        kind: "entry",
        projectId: owner.projectId,
        libraryRoot: LIBRARY_ROOT,
        relativePath: "selected/target.txt",
        operationId: owner.resourceId,
        requestHash: owner.requestHash
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records rename-time symlink and unsupported substitutions as isolated leaf types", async () => {
    for (const entryType of ["symlink", "unsupported"] as const) {
      const root = await mkdtemp(path.join(tmpdir(), `asl-files-final-${entryType}-`));
      const outside = await mkdtemp(path.join(tmpdir(), `asl-files-final-${entryType}-outside-`));
      const source = path.join(root, LIBRARY_ROOT, "selected");
      const records: Array<{ bytes: number; entryType?: string }> = [];
      let substituted = false;
      const service = new FileService(
        new FilePathValidationService(),
        new DescriptorFileTreeWalker(),
        {
          async beforeRename() {
            if (substituted) return;
            substituted = true;
            await unlink(source);
            if (entryType === "symlink") await symlink(path.join(outside, "retained.txt"), source);
            else await execFileAsync("mkfifo", [source]);
          }
        }
      );
      try {
        await mkdir(path.dirname(source), { recursive: true });
        await writeFile(source, "static");
        await writeFile(path.join(outside, "retained.txt"), "retained");
        await service.deleteLibraryFileWithAccounting(root, LIBRARY_ROOT, "selected", {
          async record(_storedPath, _delta, entry) {
            records.push({
              bytes: entry.bytes,
              ...(entry.entryType ? { entryType: entry.entryType } : {})
            });
          }
        });

        assert.equal(substituted, true);
        assert.deepEqual(records, [{ bytes: 0, entryType }]);
        assert.equal(await readFile(path.join(outside, "retained.txt"), "utf8"), "retained");
        await assert.rejects(readFile(source));
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    }
  });

  it("rejects statically observed symlink and unsupported final targets before rename", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-static-leaf-types-"));
    const outside = await mkdtemp(path.join(tmpdir(), "asl-files-static-leaf-types-outside-"));
    try {
      const parent = path.join(root, LIBRARY_ROOT, "selected");
      await mkdir(parent, { recursive: true });
      await writeFile(path.join(parent, "retained.txt"), "retained");
      await symlink(path.join(parent, "retained.txt"), path.join(parent, "link"));
      await execFileAsync("mkfifo", [path.join(parent, "fifo")]);

      const service = new FileService();
      await assert.rejects(
        () => service.deleteLibraryFile(root, LIBRARY_ROOT, "selected/link"),
        (error: unknown) => productError(error, 400, /symlink/)
      );
      await assert.rejects(
        () => service.deleteLibraryFile(root, LIBRARY_ROOT, "selected/fifo"),
        (error: unknown) => productError(error, 409, /type is not supported/)
      );
      assert.equal(await readFile(path.join(parent, "retained.txt"), "utf8"), "retained");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not follow symlink descendants during recursive deletion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-recursive-symlink-"));
    const outside = await mkdtemp(path.join(tmpdir(), "asl-files-recursive-outside-"));
    try {
      await mkdir(path.join(root, LIBRARY_ROOT, "selected"), { recursive: true });
      await writeFile(path.join(root, LIBRARY_ROOT, "selected", "local.txt"), "local");
      await writeFile(path.join(outside, "retained.txt"), "retained");
      await symlink(outside, path.join(root, LIBRARY_ROOT, "selected", "outside-link"));

      await new FileService().deleteLibraryFile(root, LIBRARY_ROOT, "selected");

      assert.equal(await readFile(path.join(outside, "retained.txt"), "utf8"), "retained");
      assert.deepEqual((await new FileService().listLibraryFiles(root, LIBRARY_ROOT)).entries, []);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not follow a descendant replaced by a symlink after isolation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "asl-files-isolated-symlink-race-"));
    const outside = await mkdtemp(path.join(tmpdir(), "asl-files-isolated-symlink-outside-"));
    try {
      const service = new FileService();
      await service.uploadLibraryFile(root, LIBRARY_ROOT, {
        path: "selected/nested/value.txt",
        bytes: Buffer.from("value")
      });
      await writeFile(path.join(outside, "retained.txt"), "retained");

      await service.deleteLibraryFileWithAccounting(root, LIBRARY_ROOT, "selected", {
        rootSubPaths: [LIBRARY_ROOT],
        async reconcile() {},
        async record() {
          const [operationId] = await readdir(path.join(root, ".deletions"));
          assert.ok(operationId);
          const nested = path.join(root, ".deletions", operationId, "entry", "nested");
          await rm(nested, { recursive: true });
          await symlink(outside, nested);
        }
      });

      assert.equal(await readFile(path.join(outside, "retained.txt"), "utf8"), "retained");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
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

function deletionOwner(suffix: string): FileDeletionOperationOwner {
  const normalized = suffix.replace(/[^A-Za-z0-9._:-]/g, "_");
  return {
    actorId: `user_${normalized}`,
    projectId: `project_${normalized}`,
    operation: "project.file.delete",
    key: `key_${normalized}`,
    requestHash: `request_${normalized}`,
    resourceId: `file_delete_${normalized}`,
    claimToken: `claim_${normalized}`
  };
}

function deletionTarget(root: string, owner: FileDeletionOperationOwner) {
  return {
    owner,
    projectRoot: root,
    libraryRoot: LIBRARY_ROOT,
    relativePath: "selected/target.txt"
  };
}

function productError(error: unknown, statusCode: number, message: RegExp, code?: string): boolean {
  assert.ok(error instanceof ProductError);
  assert.equal(error.statusCode, statusCode);
  assert.match(error.message, message);
  if (code) assert.equal(error.code, code);
  return true;
}
