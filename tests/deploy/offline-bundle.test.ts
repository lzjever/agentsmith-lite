import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { parseAppImagesLock } from "../../packages/sandbox-controller/src/appImageLock.js";

const appDigestRef = "agentsmith-lite/app@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const runnerDigestRef = "agentsmith-lite/botified-runner@sha256:2222222222222222222222222222222222222222222222222222222222222222";

describe("build offline bundle", () => {
  it("saves real image archives and writes digest-pinned bundle metadata", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-offline-bundle-"));
    const outputDir = path.join(tempDir, "bundle");
    const callsFile = path.join(tempDir, "runtime-calls.log");
    const runtime = writeFakeRuntime(tempDir, callsFile, "write");

    const result = runBundle([
      "--app-image",
      appDigestRef,
      "--runner-image",
      runnerDigestRef,
      "--runtime",
      runtime,
      "--output",
      outputDir
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(callsFile, "utf8").trim().split("\n"), [
      `image save -o ${path.join(outputDir, "images/app.tar")} ${appDigestRef}`,
      `image save -o ${path.join(outputDir, "images/botified-runner.tar")} ${runnerDigestRef}`
    ]);

    const appArchive = path.join(outputDir, "images/app.tar");
    const runnerArchive = path.join(outputDir, "images/botified-runner.tar");
    assert.equal(existsSync(appArchive), true);
    assert.equal(existsSync(runnerArchive), true);
    assert.equal(existsSync(path.join(outputDir, "manifest.yaml")), true);
    assert.equal(existsSync(path.join(outputDir, "images.lock")), true);
    assert.equal(existsSync(path.join(outputDir, "checksums.txt")), true);

    const imagesLock = readFileSync(path.join(outputDir, "images.lock"), "utf8");
    assert.deepEqual(parseAppImagesLock(imagesLock), {
      app: appDigestRef,
      botifiedRunner: runnerDigestRef
    });
    assert.doesNotMatch(imagesLock, /:dev(?:@|\s|$)/);

    const checksumEntries = parseChecksums(readFileSync(path.join(outputDir, "checksums.txt"), "utf8"));
    assert.deepEqual(Object.keys(checksumEntries).sort(), [
      "images.lock",
      "images/app.tar",
      "images/botified-runner.tar",
      "manifest.yaml"
    ]);
    assert.equal(checksumEntries["manifest.yaml"], sha256File(path.join(outputDir, "manifest.yaml")));
    assert.equal(checksumEntries["images.lock"], sha256File(path.join(outputDir, "images.lock")));
    assert.equal(checksumEntries["images/app.tar"], sha256File(appArchive));
    assert.equal(checksumEntries["images/botified-runner.tar"], sha256File(runnerArchive));
  });

  it("fails closed for mutable tags, missing image refs, and missing or empty archives", () => {
    const cases: Array<{
      name: string;
      args: string[];
      runtimeMode?: "write" | "missing" | "empty";
      error: RegExp;
    }> = [
      {
        name: "mutable app tag",
        args: ["--app-image", "agentsmith-lite/app:dev", "--runner-image", runnerDigestRef],
        error: /digest-pinned/
      },
      {
        name: "missing app image",
        args: ["--runner-image", runnerDigestRef],
        error: /--app-image/
      },
      {
        name: "missing runner image",
        args: ["--app-image", appDigestRef],
        error: /--runner-image/
      },
      {
        name: "runtime did not create archive",
        args: ["--app-image", appDigestRef, "--runner-image", runnerDigestRef],
        runtimeMode: "missing",
        error: /archive/
      },
      {
        name: "runtime created empty archive",
        args: ["--app-image", appDigestRef, "--runner-image", runnerDigestRef],
        runtimeMode: "empty",
        error: /empty|archive/
      }
    ];

    for (const candidate of cases) {
      const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-offline-bundle-invalid-"));
      const outputDir = path.join(tempDir, "bundle");
      const callsFile = path.join(tempDir, "runtime-calls.log");
      const runtime = writeFakeRuntime(tempDir, callsFile, candidate.runtimeMode ?? "write");
      const result = runBundle([...candidate.args, "--runtime", runtime, "--output", outputDir]);

      assert.notEqual(result.status, 0, candidate.name);
      assert.match(result.stderr, candidate.error, candidate.name);
    }
  });
});

function runBundle(args: string[]) {
  return spawnSync("bash", ["scripts/build-offline-bundle.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

function writeFakeRuntime(tempDir: string, callsFile: string, mode: "write" | "missing" | "empty"): string {
  const runtime = path.join(tempDir, "fake-docker");
  writeFileSync(
    runtime,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${callsFile}"
if [ "$#" -ne 5 ] || [ "$1" != "image" ] || [ "$2" != "save" ] || [ "$3" != "-o" ]; then
  echo "unexpected fake runtime args: $*" >&2
  exit 9
fi
case "${mode}" in
  write) printf 'archive for %s\\n' "$5" > "$4" ;;
  missing) ;;
  empty) : > "$4" ;;
esac
`
  );
  chmodSync(runtime, 0o755);
  return runtime;
}

function parseChecksums(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.trim().split("\n")) {
    const match = /^(?<sha>[a-f0-9]{64})  (?<file>.+)$/.exec(line);
    assert.ok(match?.groups, `invalid checksum line: ${line}`);
    const file = match.groups.file;
    const sha = match.groups.sha;
    assert.ok(file);
    assert.ok(sha);
    entries[file] = sha;
  }
  return entries;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
