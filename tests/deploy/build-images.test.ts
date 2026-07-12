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
const appPublicBaseUrl = "http://localhost:3000/app";

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

  it("builds runner binaries sequentially in one Rust stage", () => {
    const dockerfile = readFileSync(path.join(process.cwd(), "infra/docker/Dockerfile.botified-runner"), "utf8");
    const runtimeStart = dockerfile.indexOf("\nFROM debian:bookworm-slim");
    assert.notEqual(runtimeStart, -1, "Dockerfile.botified-runner must include its Debian runtime stage");
    const buildStage = dockerfile.slice(0, runtimeStart);

    assert.equal((dockerfile.match(/^FROM rust:1-bookworm\b/gm) ?? []).length, 1);
    assert.match(buildStage, /^FROM rust:1-bookworm AS build$/m);
    assert.match(
      buildStage,
      /WORKDIR \/src\/bash-executor\nARG CARGO_BUILD_JOBS=1\nCOPY packages\/bash-executor \.\/\nRUN cargo build --jobs "\$CARGO_BUILD_JOBS" --release --bin bash-executor\n\nWORKDIR \/src\/botified\nCOPY third_party\/botified \.\/\nRUN cargo build --jobs "\$CARGO_BUILD_JOBS" --release --bin botified/
    );
    assert.match(dockerfile, /COPY --from=build \/src\/bash-executor\/target\/release\/bash-executor \/usr\/local\/bin\/bash-executor/);
    assert.match(dockerfile, /COPY --from=build \/src\/botified\/target\/release\/botified \/usr\/local\/bin\/botified/);
  });

  it("pushes images with the selected runtime and writes images.lock from canonical RepoDigests", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-build-images-"));
    const callsFile = path.join(tempDir, "runtime-calls.log");
    const runtime = writeFakeRuntime(tempDir, callsFile, "canonical");
    const lockFile = path.join(tempDir, "images.lock");

    const result = runBuildImages(["--tag", "release-1", "--runtime", runtime, "--push", "--images-lock", lockFile], {
      APP_PUBLIC_BASE_URL: appPublicBaseUrl,
      NODE_BUILD_HEAP_MB: "1536",
      CARGO_BUILD_JOBS: "2"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readCalls(callsFile), [
      "build --build-arg APP_PUBLIC_BASE_URL=http://localhost:3000/app --build-arg NODE_BUILD_HEAP_MB=1536 -f infra/docker/Dockerfile.app -t agentsmith-lite/app:release-1 .",
      "build --build-arg CARGO_BUILD_JOBS=2 -f infra/docker/Dockerfile.botified-runner -t agentsmith-lite/botified-runner:release-1 .",
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

  it("requires an explicit public URL for the Next build", () => {
    const result = runBuildImages(["--tag", "dev", "--dry-run"], { APP_PUBLIC_BASE_URL: "" });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /APP_PUBLIC_BASE_URL is required/);
  });

  it("starts the web server only when the rendered public URL matches the image build URL", () => {
    const result = spawnSync("node", ["scripts/web/start.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        APP_BUILD_PUBLIC_BASE_URL: "https://agentsmith.example.test/app",
        APP_PUBLIC_BASE_URL: "https://agentsmith.example.test"
      }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the image build URL/);
  });

  it("requires --push when --images-lock is requested", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-build-images-no-push-"));
    const lockFile = path.join(tempDir, "images.lock");

    const result = runBuildImages(["--tag", "dev", "--images-lock", lockFile], { APP_PUBLIC_BASE_URL: appPublicBaseUrl });

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

    const result = runBuildImages(["--tag", "dev", "--runtime", runtime, "--push", "--images-lock", lockFile], {
      APP_PUBLIC_BASE_URL: appPublicBaseUrl
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RepoDigest|digest/i);
    assert.equal(existsSync(lockFile), false);
  });
});

function runBuildImages(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["scripts/build-images.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env, APP_PUBLIC_BASE_URL: env.APP_PUBLIC_BASE_URL ?? appPublicBaseUrl }
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
