import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { parseAppImagesLock } from "../../packages/sandbox-controller/src/appImageLock.js";

const appDigestRef = "agentsmith-lite/app@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const runnerDigestRef = "agentsmith-lite/botified-runner@sha256:2222222222222222222222222222222222222222222222222222222222222222";
const localImageId = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("build images", () => {
  it("copies workspace package manifests before npm ci in the app image", () => {
    const rootPackageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      workspaces?: unknown;
    };
    const workspaces = readWorkspacePaths(rootPackageJson.workspaces);
    const dockerfile = readFileSync(path.join(process.cwd(), "infra/docker/Dockerfile.app"), "utf8");
    const copySources = dockerCopySourcesBeforeNpmCi(dockerfile);

    assert.notEqual(workspaces.length, 0);
    for (const workspace of workspaces) {
      const manifestPath = `${workspace}/package.json`;
      assert.equal(
        copySources.includes(manifestPath),
        true,
        `Dockerfile.app must COPY ${manifestPath} before RUN npm ci`
      );
    }
  });

  it("pushes images with the selected runtime and writes images.lock from canonical RepoDigests", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-build-images-"));
    const callsFile = path.join(tempDir, "runtime-calls.log");
    const runtime = writeFakeRuntime(tempDir, callsFile, "canonical");
    const lockFile = path.join(tempDir, "images.lock");

    const result = runBuildImages(["--tag", "release-1", "--runtime", runtime, "--push", "--images-lock", lockFile]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readCalls(callsFile), [
      "build -f infra/docker/Dockerfile.app -t agentsmith-lite/app:release-1 .",
      "build -f infra/docker/Dockerfile.botified-runner -t agentsmith-lite/botified-runner:release-1 .",
      "push agentsmith-lite/app:release-1",
      "push agentsmith-lite/botified-runner:release-1",
      "image inspect agentsmith-lite/app:release-1",
      "image inspect agentsmith-lite/botified-runner:release-1"
    ]);

    const imagesLock = readFileSync(lockFile, "utf8");
    assert.deepEqual(parseAppImagesLock(imagesLock), {
      app: appDigestRef,
      botifiedRunner: runnerDigestRef
    });
    assert.doesNotMatch(imagesLock, new RegExp(localImageId));
    assert.doesNotMatch(imagesLock, /:release-1(?:@|\s|$)/);
  });

  it("requires --push when --images-lock is requested", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-build-images-no-push-"));
    const lockFile = path.join(tempDir, "images.lock");

    const result = runBuildImages(["--tag", "dev", "--images-lock", lockFile]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--images-lock.*--push/);
    assert.equal(existsSync(lockFile), false);
  });

  it("fails closed when RepoDigests do not contain the canonical app or runner digest refs", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-build-images-missing-digest-"));
    const callsFile = path.join(tempDir, "runtime-calls.log");
    const runtime = writeFakeRuntime(tempDir, callsFile, "id-only");
    const lockFile = path.join(tempDir, "images.lock");
    writeFileSync(lockFile, `${appDigestRef}\n${runnerDigestRef}\n`);

    const result = runBuildImages(["--tag", "dev", "--runtime", runtime, "--push", "--images-lock", lockFile]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RepoDigest|digest/i);
    assert.equal(existsSync(lockFile), false);
    assert.equal(readCalls(callsFile).includes("image inspect agentsmith-lite/app:dev"), true);
  });

  it("dry-run prints build, push, and write-lock intent without calling the runtime or writing files", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-build-images-dry-run-"));
    const runtime = path.join(tempDir, "runtime-not-called");
    const lockFile = path.join(tempDir, "images.lock");

    const result = runBuildImages(["--tag", "qa", "--runtime", runtime, "--push", "--images-lock", lockFile, "--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      `${runtime} build -f infra/docker/Dockerfile.app -t agentsmith-lite/app:qa .`,
      `${runtime} build -f infra/docker/Dockerfile.botified-runner -t agentsmith-lite/botified-runner:qa .`,
      `${runtime} push agentsmith-lite/app:qa`,
      `${runtime} push agentsmith-lite/botified-runner:qa`,
      `write images.lock from RepoDigests to ${lockFile}`
    ]);
    assert.equal(existsSync(lockFile), false);
  });

  it("dry-run uses CONTAINER_RUNTIME when --runtime is omitted", () => {
    const result = runBuildImages(["--tag", "dev", "--dry-run"], {
      ...process.env,
      CONTAINER_RUNTIME: "nerdctl"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "nerdctl build -f infra/docker/Dockerfile.app -t agentsmith-lite/app:dev .",
      "nerdctl build -f infra/docker/Dockerfile.botified-runner -t agentsmith-lite/botified-runner:dev ."
    ]);
  });
});

function runBuildImages(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("bash", ["scripts/build-images.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env
  });
}

function readWorkspacePaths(workspaces: unknown): string[] {
  if (Array.isArray(workspaces) && workspaces.every((workspace): workspace is string => typeof workspace === "string")) {
    return workspaces;
  }
  if (
    typeof workspaces === "object" &&
    workspaces !== null &&
    Array.isArray((workspaces as { packages?: unknown }).packages) &&
    (workspaces as { packages: unknown[] }).packages.every((workspace): workspace is string => typeof workspace === "string")
  ) {
    return (workspaces as { packages: string[] }).packages;
  }
  throw new Error("root package.json workspaces must be a string array or { packages: string[] }");
}

function dockerCopySourcesBeforeNpmCi(dockerfile: string): string[] {
  const linesBeforeNpmCi: string[] = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    if (/^\s*RUN\s+npm\s+ci\b/.test(line)) {
      break;
    }
    linesBeforeNpmCi.push(line);
  }
  return linesBeforeNpmCi.flatMap((line) => {
    const match = /^\s*COPY\s+(.+)$/.exec(line);
    if (!match) {
      return [];
    }
    const copyArgs = match[1];
    if (copyArgs === undefined) {
      return [];
    }
    return copyArgs.trim().split(/\s+/).slice(0, -1);
  });
}

function writeFakeRuntime(tempDir: string, callsFile: string, mode: "canonical" | "id-only"): string {
  writeFileSync(callsFile, "");
  const runtime = path.join(tempDir, "fake-docker");
  writeFileSync(
    runtime,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${callsFile}"
case "$1" in
  build) exit 0 ;;
  push) exit 0 ;;
  image)
    if [ "$#" -ne 3 ] || [ "$2" != "inspect" ]; then
      echo "unexpected fake runtime args: $*" >&2
      exit 9
    fi
    case "${mode}:$3" in
      canonical:agentsmith-lite/app:*)
        cat <<'JSON'
[
  {
    "Id": "${localImageId}",
    "RepoDigests": [
      "registry.example.test/agentsmith-lite/app@sha256:9999999999999999999999999999999999999999999999999999999999999999",
      "${appDigestRef}"
    ]
  }
]
JSON
        ;;
      canonical:agentsmith-lite/botified-runner:*)
        cat <<'JSON'
[
  {
    "Id": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "RepoDigests": [
      "${runnerDigestRef}"
    ]
  }
]
JSON
        ;;
      id-only:*)
        cat <<'JSON'
[
  {
    "Id": "${localImageId}",
    "RepoDigests": []
  }
]
JSON
        ;;
      *)
        echo "unexpected inspect ref: $3" >&2
        exit 9
        ;;
    esac
    ;;
  *)
    echo "unexpected fake runtime args: $*" >&2
    exit 9
    ;;
esac
`
  );
  chmodSync(runtime, 0o755);
  return runtime;
}

function readCalls(callsFile: string): string[] {
  const text = readFileSync(callsFile, "utf8").trim();
  return text.length === 0 ? [] : text.split("\n");
}
