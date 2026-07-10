import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const appOciImage = createOciImage("app");
const runnerOciImage = createOciImage("botified-runner");
const appDigestRef = `agentsmith-lite/app@sha256:${appOciImage.manifestDigest}`;
const runnerDigestRef = `agentsmith-lite/botified-runner@sha256:${runnerOciImage.manifestDigest}`;

describe("deploy import images", () => {
  it("verifies the bundle metadata and imports app and runner archives into the specified k3s containerd", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-"));
    const bundle = writeBundle(tempDir);
    const callsFile = path.join(tempDir, "k3s-calls.log");
    const k3sBin = writeFakeK3s(tempDir, callsFile);

    const result = runImport(["--bundle", bundle, "--k3s-bin", k3sBin]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readCalls(callsFile), [
      `ctr -n k8s.io images import --base-name agentsmith-lite/app --digests ${path.join(bundle, "images/app.tar")}`,
      `ctr -n k8s.io images tag --force ${appDigestRef} ${appDigestRef}`,
      `ctr -n k8s.io images ls -q name==${appDigestRef}`,
      `ctr -n k8s.io images import --base-name agentsmith-lite/botified-runner --digests ${path.join(bundle, "images/botified-runner.tar")}`,
      `ctr -n k8s.io images tag --force ${runnerDigestRef} ${runnerDigestRef}`,
      `ctr -n k8s.io images ls -q name==${runnerDigestRef}`
    ]);
  });

  it("rejects a valid OCI archive whose root digest does not match the lock before calling k3s", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-root-mismatch-"));
    const bundle = writeBundle(tempDir);
    writeMinimalOciArchive(path.join(bundle, "images/app.tar"), runnerOciImage);
    writeChecksums(bundle);
    const callsFile = path.join(tempDir, "k3s-calls.log");
    const k3sBin = writeFakeK3s(tempDir, callsFile);

    const result = runImport(["--bundle", bundle, "--k3s-bin", k3sBin]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OCI.*digest|digest.*OCI/i);
    assert.deepEqual(readCalls(callsFile), []);
  });

  it("rejects a corrupted layer before calling k3s", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-layer-corrupt-"));
    const bundle = writeBundle(tempDir);
    writeMinimalOciArchive(path.join(bundle, "images/app.tar"), appOciImage, Buffer.alloc(appOciImage.layer.length, 1));
    writeChecksums(bundle);
    const callsFile = path.join(tempDir, "k3s-calls.log");
    const k3sBin = writeFakeK3s(tempDir, callsFile);

    const result = runImport(["--bundle", bundle, "--k3s-bin", k3sBin]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /layer.*hash|hash.*layer/i);
    assert.deepEqual(readCalls(callsFile), []);
  });

  it("binds the exact lock refs to verified manifests in a temporary containerd", async (t) => {
    if (spawnSync("containerd", ["--version"], { encoding: "utf8" }).status !== 0 || spawnSync("ctr", ["--version"], { encoding: "utf8" }).status !== 0) {
      t.skip("containerd and ctr are required");
      return;
    }

    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-containerd-"));
    const socket = path.join(tempDir, "containerd.sock");
    const daemon = spawn("containerd", ["--config", "/dev/null", "--root", path.join(tempDir, "root"), "--state", path.join(tempDir, "state"), "--address", socket, "--log-level", "error"], { stdio: "ignore" });
    try {
      await waitForSocket(socket, daemon);
      const bundle = writeBundle(tempDir);
      const k3sBin = path.join(tempDir, "k3s");
      writeFileSync(k3sBin, `#!/usr/bin/env bash\n[ "$1" = "ctr" ]\nshift\nif [ "$3" = "images" ] && [ "$4" = "import" ]; then\n  archive="\${!#}"\n  set -- "\${@:1:$#-1}" --no-unpack "$archive"\nfi\nexec ctr --address "${socket}" "$@"\n`);
      chmodSync(k3sBin, 0o755);

      const result = runImport(["--bundle", bundle, "--k3s-bin", k3sBin]);

      assert.equal(result.status, 0, result.stderr);
      for (const ref of [appDigestRef, runnerDigestRef]) {
        const inspect = spawnSync("ctr", ["--address", socket, "-n", "k8s.io", "images", "inspect", ref], { encoding: "utf8" });
        assert.equal(inspect.status, 0, inspect.stderr);
        assert.match(inspect.stdout, new RegExp(escapeRegExp(ref.slice(ref.indexOf("@") + 1))));
      }
    } finally {
      daemon.kill();
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects a valid bundle without an explicit k3s binary", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-missing-k3s-bin-"));
    const bundle = writeBundle(tempDir);

    const result = runImport(["--bundle", bundle]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--k3s-bin is required/);
  });

  it("rejects missing or non-executable explicit k3s binaries without invoking Docker or Podman", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-k3s-bin-"));
    const bundle = writeBundle(tempDir);
    const runtimeCallsFile = path.join(tempDir, "runtime-calls.log");
    const runtimeBinDir = writeForbiddenHostRuntimes(tempDir, runtimeCallsFile);
    const missingK3sBin = path.join(tempDir, "missing-k3s");
    const nonExecutableK3sBin = path.join(tempDir, "non-executable-k3s");
    writeFileSync(nonExecutableK3sBin, "#!/usr/bin/env bash\nexit 0\n");

    for (const k3sBin of [missingK3sBin, nonExecutableK3sBin]) {
      const result = runImport(["--bundle", bundle, "--k3s-bin", k3sBin], runtimeBinDir);

      assert.notEqual(result.status, 0, k3sBin);
      assert.match(result.stderr, /k3s.*executable|executable.*k3s/i, k3sBin);
      assert.deepEqual(readCalls(runtimeCallsFile), [], k3sBin);
    }
  });

  it("prints the archives during dry-run without calling the runtime", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-dry-run-"));
    const bundle = writeBundle(tempDir);
    const callsFile = path.join(tempDir, "k3s-calls.log");
    const k3sBin = writeFakeK3s(tempDir, callsFile);

    const result = runImport(["--bundle", bundle, "--k3s-bin", k3sBin, "--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      `${k3sBin} ctr -n k8s.io images import --base-name agentsmith-lite/app --digests ${path.join(bundle, "images/app.tar")}`,
      `${k3sBin} ctr -n k8s.io images tag --force ${appDigestRef} ${appDigestRef}`,
      `${k3sBin} ctr -n k8s.io images ls -q name==${appDigestRef}`,
      `${k3sBin} ctr -n k8s.io images import --base-name agentsmith-lite/botified-runner --digests ${path.join(bundle, "images/botified-runner.tar")}`,
      `${k3sBin} ctr -n k8s.io images tag --force ${runnerDigestRef} ${runnerDigestRef}`,
      `${k3sBin} ctr -n k8s.io images ls -q name==${runnerDigestRef}`
    ]);
    assert.equal(readCalls(callsFile).length, 0);
  });

  it("accepts a bundle images.lock with comments, blank lines, and surrounding whitespace during dry-run", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-images-lock-whitespace-"));
    const bundle = writeBundle(tempDir);
    writeBundleFile(bundle, "images.lock", `# release image refs\n  ${appDigestRef}  \n   \n\t${runnerDigestRef}\t\n`);
    const callsFile = path.join(tempDir, "k3s-calls.log");
    const k3sBin = writeFakeK3s(tempDir, callsFile);

    const result = runImport(["--bundle", bundle, "--k3s-bin", k3sBin, "--dry-run"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      `${k3sBin} ctr -n k8s.io images import --base-name agentsmith-lite/app --digests ${path.join(bundle, "images/app.tar")}`,
      `${k3sBin} ctr -n k8s.io images tag --force ${appDigestRef} ${appDigestRef}`,
      `${k3sBin} ctr -n k8s.io images ls -q name==${appDigestRef}`,
      `${k3sBin} ctr -n k8s.io images import --base-name agentsmith-lite/botified-runner --digests ${path.join(bundle, "images/botified-runner.tar")}`,
      `${k3sBin} ctr -n k8s.io images tag --force ${runnerDigestRef} ${runnerDigestRef}`,
      `${k3sBin} ctr -n k8s.io images ls -q name==${runnerDigestRef}`
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
        error: /archive|empty|OCI/
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
      const callsFile = path.join(tempDir, "k3s-calls.log");
      const k3sBin = writeFakeK3s(tempDir, callsFile);
      const args = candidate.args ?? ["--bundle", bundle, "--k3s-bin", k3sBin];

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
    const callsFile = path.join(tempDir, "k3s-calls.log");
    const k3sBin = writeFakeK3s(tempDir, callsFile);

    const result = runImport(["--bundle", bundle, "--k3s-bin", k3sBin, "--dry-run"]);

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
      const callsFile = path.join(tempDir, "k3s-calls.log");
      const k3sBin = writeFakeK3s(tempDir, callsFile);

      const result = runImport(["--bundle", bundle, "--k3s-bin", k3sBin, "--dry-run"]);

      assert.notEqual(result.status, 0, candidate.name);
      assert.match(result.stderr, /checksums\.txt|allowlist|unsupported|invalid|duplicate/i, candidate.name);
      assert.equal(readCalls(callsFile).length, 0, candidate.name);
    }
  });
});

function runImport(args: string[], pathPrefix?: string) {
  return spawnSync("bash", ["scripts/deploy/import-images.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: pathPrefix === undefined ? process.env : { ...process.env, PATH: `${pathPrefix}:${process.env.PATH}` }
  });
}

function writeBundle(tempDir: string): string {
  const bundle = path.join(tempDir, "bundle");
  mkdirSync(path.join(bundle, "images"), { recursive: true });
  writeFileSync(path.join(bundle, "images.lock"), `${appDigestRef}\n${runnerDigestRef}\n`);
  writeFileSync(path.join(bundle, "manifest.yaml"), "schema: agentsmith-lite.app-offline-bundle/v1\n");
  writeMinimalOciArchive(path.join(bundle, "images/app.tar"), appOciImage);
  writeMinimalOciArchive(path.join(bundle, "images/botified-runner.tar"), runnerOciImage);
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

function writeFakeK3s(tempDir: string, callsFile: string): string {
  writeFileSync(callsFile, "");
  const k3s = path.join(tempDir, "fake-k3s");
  writeFileSync(
    k3s,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${callsFile}"
if [ "$#" -eq 9 ] && [ "$1" = "ctr" ] && [ "$2" = "-n" ] && [ "$3" = "k8s.io" ] && [ "$4" = "images" ] && [ "$5" = "import" ] && [ "$6" = "--base-name" ] && [ "$8" = "--digests" ]; then
  exit 0
fi
if [ "$#" -eq 8 ] && [ "$1" = "ctr" ] && [ "$2" = "-n" ] && [ "$3" = "k8s.io" ] && [ "$4" = "images" ] && [ "$5" = "tag" ] && [ "$6" = "--force" ] && [ "$7" = "$8" ]; then
  exit 0
fi
if [ "$#" -eq 7 ] && [ "$1" = "ctr" ] && [ "$2" = "-n" ] && [ "$3" = "k8s.io" ] && [ "$4" = "images" ] && [ "$5" = "ls" ] && [ "$6" = "-q" ]; then
  printf '%s\n' "\${7#name==}"
  exit 0
fi
echo "unexpected fake k3s args: $*" >&2
exit 9
`
  );
  chmodSync(k3s, 0o755);
  return k3s;
}

function writeForbiddenHostRuntimes(tempDir: string, callsFile: string): string {
  const binDir = path.join(tempDir, "host-runtimes");
  mkdirSync(binDir);
  writeFileSync(callsFile, "");
  for (const runtime of ["docker", "podman"]) {
    const executable = path.join(binDir, runtime);
    writeFileSync(executable, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${runtime}" "$*" >> "${callsFile}"\nexit 9\n`);
    chmodSync(executable, 0o755);
  }
  return binDir;
}

function readCalls(callsFile: string): string[] {
  const text = readFileSync(callsFile, "utf8").trim();
  return text.length === 0 ? [] : text.split("\n");
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function waitForSocket(socket: string, daemon: ReturnType<typeof spawn>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(socket)) return;
    if (daemon.exitCode !== null) throw new Error(`temporary containerd exited with ${daemon.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("temporary containerd did not create its socket");
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
  return { config, configDigest, layer, layerDigest, manifest, manifestDigest: createHash("sha256").update(manifest).digest("hex"), name };
}

function writeMinimalOciArchive(archive: string, image: ReturnType<typeof createOciImage>, layer = image.layer): void {
  const layout = `${archive}.oci`;
  mkdirSync(path.join(layout, "blobs", "sha256"), { recursive: true });
  writeFileSync(path.join(layout, "oci-layout"), `${JSON.stringify({ imageLayoutVersion: "1.0.0" })}\n`);
  writeFileSync(path.join(layout, "blobs", "sha256", image.configDigest), image.config);
  writeFileSync(path.join(layout, "blobs", "sha256", image.layerDigest), layer);
  writeFileSync(path.join(layout, "blobs", "sha256", image.manifestDigest), image.manifest);
  writeFileSync(path.join(layout, "index.json"), `${JSON.stringify({
    manifests: [{ digest: `sha256:${image.manifestDigest}`, mediaType: "application/vnd.oci.image.manifest.v1+json", size: image.manifest.length }],
    schemaVersion: 2
  })}\n`);
  const result = spawnSync("tar", ["-C", layout, "-cf", archive, "index.json", "oci-layout", "blobs"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  rmSync(layout, { force: true, recursive: true });
}
