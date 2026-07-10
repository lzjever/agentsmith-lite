import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { parseAppImagesLock } from "../../packages/sandbox-controller/src/appImageLock.js";

const appOciImage = createOciImage("app");
const runnerOciImage = createOciImage("botified-runner");
const appDigestRef = `agentsmith-lite/app@sha256:${appOciImage.manifestDigest}`;
const runnerDigestRef = `agentsmith-lite/botified-runner@sha256:${runnerOciImage.manifestDigest}`;

describe("build offline bundle", () => {
  it("exports digest-pinned OCI archives with skopeo and writes bundle metadata", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-offline-bundle-"));
    const outputDir = path.join(tempDir, "bundle");
    const callsFile = path.join(tempDir, "skopeo-calls.log");
    const skopeoBin = writeFakeSkopeo(tempDir, callsFile, "write");

    const result = runBundle([
      "--app-image",
      appDigestRef,
      "--runner-image",
      runnerDigestRef,
      "--output",
      outputDir
    ], skopeoBin);

    assert.equal(result.status, 0, result.stderr);
    assertSkopeoCopies(callsFile, [appDigestRef, runnerDigestRef]);

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

  it("reads digest refs from --images-lock instead of requiring manual image arguments", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-offline-bundle-lock-"));
    const outputDir = path.join(tempDir, "bundle");
    const lockFile = path.join(tempDir, "images.lock");
    const callsFile = path.join(tempDir, "skopeo-calls.log");
    const skopeoBin = writeFakeSkopeo(tempDir, callsFile, "write");
    writeFileSync(lockFile, `# release image refs\n  ${appDigestRef}  \n   \n\t${runnerDigestRef}\t\n`);

    const result = runBundle(["--images-lock", lockFile, "--output", outputDir], skopeoBin);

    assert.equal(result.status, 0, result.stderr);
    assertSkopeoCopies(callsFile, [appDigestRef, runnerDigestRef]);
    assert.deepEqual(parseAppImagesLock(readFileSync(path.join(outputDir, "images.lock"), "utf8")), {
      app: appDigestRef,
      botifiedRunner: runnerDigestRef
    });
    assert.equal(readFileSync(path.join(outputDir, "images.lock"), "utf8"), `${appDigestRef}\n${runnerDigestRef}\n`);
  });

  it("restores an existing bundle when publishing the staged bundle fails", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-offline-bundle-rollback-"));
    const outputDir = path.join(tempDir, "bundle");
    mkdirSync(outputDir);
    writeFileSync(path.join(outputDir, "complete.txt"), "existing bundle\n");
    const callsFile = path.join(tempDir, "skopeo-calls.log");
    const skopeoBin = writeFakeSkopeo(tempDir, callsFile, "write");
    writeFailingPublishMv(skopeoBin, outputDir);

    const result = runBundle(["--app-image", appDigestRef, "--runner-image", runnerDigestRef, "--output", outputDir], skopeoBin);

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(path.join(outputDir, "complete.txt"), "utf8"), "existing bundle\n");
    assert.equal(existsSync(path.join(outputDir, "manifest.yaml")), false);
  });

  it("fails closed when --images-lock is mixed with explicit image arguments or contains invalid refs", () => {
    const cases: Array<{
      name: string;
      lock: string;
      args: string[];
      error: RegExp;
    }> = [
      {
        name: "mixed app image",
        lock: `${appDigestRef}\n${runnerDigestRef}\n`,
        args: ["--app-image", appDigestRef],
        error: /--images-lock.*--app-image|--app-image.*--images-lock/
      },
      {
        name: "mixed runner image",
        lock: `${appDigestRef}\n${runnerDigestRef}\n`,
        args: ["--runner-image", runnerDigestRef],
        error: /--images-lock.*--runner-image|--runner-image.*--images-lock/
      },
      {
        name: "invalid lock",
        lock: `agentsmith-lite/app:dev\n${runnerDigestRef}\n`,
        args: [],
        error: /images\.lock|digest-pinned|mutable/
      }
    ];

    for (const candidate of cases) {
      const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-offline-bundle-lock-invalid-"));
      const outputDir = path.join(tempDir, "bundle");
      const lockFile = path.join(tempDir, "images.lock");
      const callsFile = path.join(tempDir, "skopeo-calls.log");
      const skopeoBin = writeFakeSkopeo(tempDir, callsFile, "write");
      writeFileSync(callsFile, "");
      writeFileSync(lockFile, candidate.lock);

      const result = runBundle(["--images-lock", lockFile, ...candidate.args, "--output", outputDir], skopeoBin);

      assert.notEqual(result.status, 0, candidate.name);
      assert.match(result.stderr, candidate.error, candidate.name);
      assert.equal(readFileSync(callsFile, "utf8").trim(), "", candidate.name);
    }
  });

  it("fails closed for invalid refs and invalid skopeo archive output before publication", () => {
    const cases: Array<{
      name: string;
      args: string[];
      skopeoMode?: "write" | "missing" | "empty" | "mismatched";
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
        name: "skopeo did not create archive",
        args: ["--app-image", appDigestRef, "--runner-image", runnerDigestRef],
        skopeoMode: "missing",
        error: /archive/
      },
      {
        name: "skopeo created empty archive",
        args: ["--app-image", appDigestRef, "--runner-image", runnerDigestRef],
        skopeoMode: "empty",
        error: /empty|archive/
      },
      {
        name: "skopeo created a valid OCI archive with the wrong root digest",
        args: ["--app-image", appDigestRef, "--runner-image", runnerDigestRef],
        skopeoMode: "mismatched",
        error: /OCI.*digest|digest.*OCI/
      }
    ];

    for (const candidate of cases) {
      const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-offline-bundle-invalid-"));
      const outputDir = path.join(tempDir, "bundle");
      const callsFile = path.join(tempDir, "skopeo-calls.log");
      const skopeoBin = writeFakeSkopeo(tempDir, callsFile, candidate.skopeoMode ?? "write");
      const result = runBundle([...candidate.args, "--output", outputDir], skopeoBin);

      assert.notEqual(result.status, 0, candidate.name);
      assert.match(result.stderr, candidate.error, candidate.name);
      if (candidate.skopeoMode === "mismatched") {
        assert.equal(existsSync(outputDir), false, candidate.name);
      }
    }
  });
});

function runBundle(args: string[], pathPrefix?: string) {
  return spawnSync("bash", ["scripts/build-offline-bundle.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: pathPrefix === undefined ? process.env : { ...process.env, PATH: `${pathPrefix}:${process.env.PATH}` }
  });
}

function writeFakeSkopeo(tempDir: string, callsFile: string, mode: "write" | "missing" | "empty" | "mismatched"): string {
  const binDir = path.join(tempDir, "bin");
  mkdirSync(binDir);
  const skopeo = path.join(binDir, "skopeo");
  const appArchive = path.join(tempDir, "app.oci.tar");
  const runnerArchive = path.join(tempDir, "runner.oci.tar");
  writeMinimalOciArchive(appArchive, appOciImage);
  writeMinimalOciArchive(runnerArchive, runnerOciImage);
  writeFileSync(
    skopeo,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${callsFile}"
if [ "$#" -ne 4 ] || [ "$1" != "copy" ] || [ "$2" != "--preserve-digests" ]; then
  echo "unexpected fake skopeo args: $*" >&2
  exit 9
fi
archive="\${4#oci-archive:}"
archive="\${archive%:*}"
case "${mode}" in
  write)
    case "$3" in
      "docker://${appDigestRef}") cp "${appArchive}" "$archive" ;;
      "docker://${runnerDigestRef}") cp "${runnerArchive}" "$archive" ;;
      *) exit 9 ;;
    esac
    ;;
  missing) ;;
  empty) : > "$archive" ;;
  mismatched) cp "${runnerArchive}" "$archive" ;;
esac
`
  );
  chmodSync(skopeo, 0o755);
  return binDir;
}

function writeFailingPublishMv(binDir: string, outputDir: string): void {
  const executable = path.join(binDir, "mv");
  writeFileSync(executable, `#!/usr/bin/env bash
if [[ "$1" == *".bundle.staging."* ]] && [ "$2" = "${outputDir}" ]; then
  exit 1
fi
exec /bin/mv "$@"
`);
  chmodSync(executable, 0o755);
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

function assertSkopeoCopies(callsFile: string, refs: string[]): void {
  const calls = readFileSync(callsFile, "utf8").trim().split("\n");
  assert.equal(calls.length, refs.length);
  for (const [index, ref] of refs.entries()) {
    const imageName = ref.split("@")[0];
    assert.match(calls[index] ?? "", new RegExp(`^copy --preserve-digests docker://${escapeRegExp(ref)} oci-archive:.+:${escapeRegExp(imageName ?? "")}$`));
  }
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createOciImage(name: string) {
  const layer = Buffer.alloc(1024);
  const layerDigest = createHash("sha256").update(layer).digest("hex");
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", config: { name }, os: "linux", rootfs: { diff_ids: [`sha256:${layerDigest}`], type: "layers" } }));
  const configDigest = createHash("sha256").update(config).digest("hex");
  const manifest = Buffer.from(JSON.stringify({
    config: { digest: `sha256:${configDigest}`, mediaType: "application/vnd.oci.image.config.v1+json", size: config.length },
    layers: [{ digest: `sha256:${layerDigest}`, mediaType: "application/vnd.oci.image.layer.v1.tar", size: layer.length }],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2
  }));
  return { config, configDigest, layer, layerDigest, manifest, manifestDigest: createHash("sha256").update(manifest).digest("hex") };
}

function writeMinimalOciArchive(archive: string, image: ReturnType<typeof createOciImage>): void {
  const layout = `${archive}.oci`;
  mkdirSync(path.join(layout, "blobs", "sha256"), { recursive: true });
  writeFileSync(path.join(layout, "oci-layout"), `${JSON.stringify({ imageLayoutVersion: "1.0.0" })}\n`);
  writeFileSync(path.join(layout, "blobs", "sha256", image.configDigest), image.config);
  writeFileSync(path.join(layout, "blobs", "sha256", image.layerDigest), image.layer);
  writeFileSync(path.join(layout, "blobs", "sha256", image.manifestDigest), image.manifest);
  writeFileSync(path.join(layout, "index.json"), `${JSON.stringify({
    manifests: [{ digest: `sha256:${image.manifestDigest}`, mediaType: "application/vnd.oci.image.manifest.v1+json", size: image.manifest.length }],
    schemaVersion: 2
  })}\n`);
  const result = spawnSync("tar", ["-C", layout, "-cf", archive, "index.json", "oci-layout", "blobs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  rmSync(layout, { force: true, recursive: true });
}
