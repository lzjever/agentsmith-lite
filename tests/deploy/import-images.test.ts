import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const appDigestRef = "agentsmith-lite/app@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const runnerDigestRef = "agentsmith-lite/botified-runner@sha256:2222222222222222222222222222222222222222222222222222222222222222";

describe("deploy import images", () => {
  it("verifies the bundle metadata and imports app and runner image archives", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-"));
    const bundle = writeBundle(tempDir);
    const callsFile = path.join(tempDir, "runtime-calls.log");
    const runtime = writeFakeRuntime(tempDir, callsFile);

    const result = runImport(["--bundle", bundle, "--runtime", runtime]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readCalls(callsFile), [
      `image load -i ${path.join(bundle, "images/app.tar")}`,
      `image load -i ${path.join(bundle, "images/botified-runner.tar")}`
    ]);
  });

  it("prints the archives during dry-run without calling the runtime", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-dry-run-"));
    const bundle = writeBundle(tempDir);
    const callsFile = path.join(tempDir, "runtime-calls.log");
    const runtime = writeFakeRuntime(tempDir, callsFile);

    const result = runImport(["--bundle", bundle, "--runtime", runtime, "--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      `image load -i ${path.join(bundle, "images/app.tar")}`,
      `image load -i ${path.join(bundle, "images/botified-runner.tar")}`
    ]);
    assert.equal(readCalls(callsFile).length, 0);
  });

  it("accepts a bundle images.lock with comments, blank lines, and surrounding whitespace during dry-run", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-lock-whitespace-"));
    const bundle = writeBundle(tempDir);
    writeBundleFile(bundle, "images.lock", `# release image refs\n  ${appDigestRef}  \n   \n\t${runnerDigestRef}\t\n`);
    const callsFile = path.join(tempDir, "runtime-calls.log");
    const runtime = writeFakeRuntime(tempDir, callsFile);

    const result = runImport(["--bundle", bundle, "--runtime", runtime, "--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      `image load -i ${path.join(bundle, "images/app.tar")}`,
      `image load -i ${path.join(bundle, "images/botified-runner.tar")}`
    ]);
    assert.equal(readCalls(callsFile).length, 0);
  });

  it("fails closed for missing bundle metadata, invalid lock contents, checksum mismatches, and missing archives", () => {
    const cases: Array<{
      name: string;
      mutate?: (bundle: string) => void;
      args?: string[];
      error: RegExp;
    }> = [
      {
        name: "missing bundle arg",
        args: [],
        error: /--bundle/
      },
      {
        name: "missing checksums",
        mutate: (bundle) => rmSync(path.join(bundle, "checksums.txt")),
        error: /checksums\.txt/
      },
      {
        name: "checksum mismatch",
        mutate: (bundle) => writeFileSync(path.join(bundle, "images/app.tar"), "tampered\n"),
        error: /checksum|FAILED/i
      },
      {
        name: "missing archive",
        mutate: (bundle) => rmSync(path.join(bundle, "images/app.tar")),
        error: /archive|missing/
      },
      {
        name: "empty archive",
        mutate: (bundle) => {
          writeFileSync(path.join(bundle, "images/app.tar"), "");
          writeChecksums(bundle);
        },
        error: /archive|empty/
      },
      {
        name: "missing app lock ref",
        mutate: (bundle) => writeBundleFile(bundle, "images.lock", `${runnerDigestRef}\n`),
        error: /missing.*app/i
      },
      {
        name: "missing runner lock ref",
        mutate: (bundle) => writeBundleFile(bundle, "images.lock", `${appDigestRef}\n`),
        error: /missing.*botified-runner|missing.*runner/i
      },
      {
        name: "mutable tag",
        mutate: (bundle) => writeBundleFile(bundle, "images.lock", `agentsmith-lite/app:dev\n${runnerDigestRef}\n`),
        error: /mutable|digest-pinned/
      },
      {
        name: "duplicate app ref",
        mutate: (bundle) => writeBundleFile(bundle, "images.lock", `${appDigestRef}\n${appDigestRef}\n${runnerDigestRef}\n`),
        error: /duplicate/
      },
      {
        name: "unsupported ref",
        mutate: (bundle) => writeBundleFile(bundle, "images.lock", `${appDigestRef}\n${runnerDigestRef}\nother/image@sha256:${"3".repeat(64)}\n`),
        error: /unsupported/
      }
    ];

    for (const candidate of cases) {
      const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-invalid-"));
      const bundle = writeBundle(tempDir);
      candidate.mutate?.(bundle);
      const callsFile = path.join(tempDir, "runtime-calls.log");
      const runtime = writeFakeRuntime(tempDir, callsFile);
      const args = candidate.args ?? ["--bundle", bundle, "--runtime", runtime];

      const result = runImport(args);

      assert.notEqual(result.status, 0, candidate.name);
      assert.match(result.stderr, candidate.error, candidate.name);
      assert.equal(readCalls(callsFile).length, 0, candidate.name);
    }
  });

  it("fails dry-run when checksums.txt includes a path escape without calling the runtime", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-checksum-escape-"));
    const bundle = writeBundle(tempDir);
    const outsideFile = path.join(tempDir, "outside.txt");
    writeFileSync(outsideFile, "outside\n");
    appendChecksumLine(bundle, "../outside.txt", sha256File(outsideFile));
    const callsFile = path.join(tempDir, "runtime-calls.log");
    const runtime = writeFakeRuntime(tempDir, callsFile);

    const result = runImport(["--bundle", bundle, "--runtime", runtime, "--dry-run"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksums\.txt|allowlist|unsupported|invalid/i);
    assert.equal(readCalls(callsFile).length, 0);
  });

  it("fails dry-run for non-allowlisted, absolute, URL-like, duplicate, and malformed checksum entries", () => {
    const cases: Array<{
      name: string;
      mutate: (bundle: string, tempDir: string) => void;
    }> = [
      {
        name: "extra non-allowlisted entry",
        mutate: (bundle) => {
          writeFileSync(path.join(bundle, "extra.txt"), "extra\n");
          appendChecksumLine(bundle, "extra.txt", sha256File(path.join(bundle, "extra.txt")));
        }
      },
      {
        name: "absolute path",
        mutate: (bundle, tempDir) => {
          const absoluteFile = path.join(tempDir, "absolute.txt");
          writeFileSync(absoluteFile, "absolute\n");
          appendChecksumLine(bundle, absoluteFile, sha256File(absoluteFile));
        }
      },
      {
        name: "URL-like path",
        mutate: (bundle) => {
          const urlLikeFile = path.join(bundle, "https:/example.com/app.tar");
          mkdirSync(path.dirname(urlLikeFile), { recursive: true });
          writeFileSync(urlLikeFile, "url-like\n");
          appendChecksumLine(bundle, "https://example.com/app.tar", sha256File(urlLikeFile));
        }
      },
      {
        name: "duplicate entry",
        mutate: (bundle) => appendChecksumLine(bundle, "images/app.tar", sha256File(path.join(bundle, "images/app.tar")))
      },
      {
        name: "malformed empty path",
        mutate: (bundle) => appendChecksumLine(bundle, "", "0".repeat(64))
      }
    ];

    for (const candidate of cases) {
      const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-checksum-contract-"));
      const bundle = writeBundle(tempDir);
      candidate.mutate(bundle, tempDir);
      const callsFile = path.join(tempDir, "runtime-calls.log");
      const runtime = writeFakeRuntime(tempDir, callsFile);

      const result = runImport(["--bundle", bundle, "--runtime", runtime, "--dry-run"]);

      assert.notEqual(result.status, 0, candidate.name);
      assert.match(result.stderr, /checksums\.txt|allowlist|unsupported|invalid|duplicate/i, candidate.name);
      assert.equal(readCalls(callsFile).length, 0, candidate.name);
    }
  });
});

function runImport(args: string[]) {
  return spawnSync("bash", ["scripts/deploy/import-images.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

function writeBundle(tempDir: string): string {
  const bundle = path.join(tempDir, "bundle");
  mkdirSync(path.join(bundle, "images"), { recursive: true });
  writeFileSync(path.join(bundle, "images.lock"), `${appDigestRef}\n${runnerDigestRef}\n`);
  writeFileSync(path.join(bundle, "manifest.yaml"), "schema: agentsmith-lite.app-offline-bundle/v1\n");
  writeFileSync(path.join(bundle, "images/app.tar"), "app archive\n");
  writeFileSync(path.join(bundle, "images/botified-runner.tar"), "runner archive\n");
  writeChecksums(bundle);
  return bundle;
}

function writeBundleFile(bundle: string, relativePath: string, content: string): void {
  writeFileSync(path.join(bundle, relativePath), content);
  writeChecksums(bundle);
}

function writeChecksums(bundle: string): void {
  const files = ["manifest.yaml", "images.lock", "images/app.tar", "images/botified-runner.tar"];
  const lines = files.map((file) => `${sha256File(path.join(bundle, file))}  ${file}`);
  writeFileSync(path.join(bundle, "checksums.txt"), `${lines.join("\n")}\n`);
}

function appendChecksumLine(bundle: string, relativePath: string, sha256: string): void {
  writeFileSync(path.join(bundle, "checksums.txt"), `${readFileSync(path.join(bundle, "checksums.txt"), "utf8")}${sha256}  ${relativePath}\n`);
}

function writeFakeRuntime(tempDir: string, callsFile: string): string {
  writeFileSync(callsFile, "");
  const runtime = path.join(tempDir, "fake-docker");
  writeFileSync(
    runtime,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${callsFile}"
if [ "$#" -ne 4 ] || [ "$1" != "image" ] || [ "$2" != "load" ] || [ "$3" != "-i" ]; then
  echo "unexpected fake runtime args: $*" >&2
  exit 9
fi
`
  );
  chmodSync(runtime, 0o755);
  return runtime;
}

function readCalls(callsFile: string): string[] {
  const text = readFileSync(callsFile, "utf8").trim();
  return text.length === 0 ? [] : text.split("\n");
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
