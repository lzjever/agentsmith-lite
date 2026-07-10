import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const appImage = "agentsmith-lite/app:dev";
const runnerImage = "agentsmith-lite/botified-runner:dev";
const apiDeployment = "deployment/agentsmith-lite-api";
const namespace = "agentsmith-preview";
const kubeContext = "agentsmith-local";

describe("deploy import dev images", () => {
  it("validates and streams both local Docker dev images into the explicit k3s containerd, then restarts the existing API deployment in the substrate context", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-dev-images-"));
    const dockerCalls = path.join(tempDir, "docker-calls.log");
    const k3sCalls = path.join(tempDir, "k3s-calls.log");
    const kubectlCalls = path.join(tempDir, "kubectl-calls.log");
    const binDir = writeFakes(tempDir, dockerCalls, k3sCalls, kubectlCalls);
    const k3sBin = path.join(binDir, "k3s");

    const result = runImport(importArgs(binDir), binDir);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readCalls(dockerCalls), [
      `image inspect ${appImage}`,
      `image inspect ${runnerImage}`,
      `image save ${appImage}`,
      `image save ${runnerImage}`
    ]);
    assert.deepEqual(readCalls(k3sCalls), [
      "ctr -n k8s.io images import -",
      "ctr -n k8s.io images import -"
    ]);
    assert.deepEqual(readCalls(kubectlCalls), [
      `${kubectlGlobals(binDir)} get ${apiDeployment} --ignore-not-found -o name`,
      `${kubectlGlobals(binDir)} rollout restart ${apiDeployment}`
    ]);
  });

  it("skips restart after image import when the API deployment does not exist yet", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-dev-images-first-install-"));
    const dockerCalls = path.join(tempDir, "docker-calls.log");
    const k3sCalls = path.join(tempDir, "k3s-calls.log");
    const kubectlCalls = path.join(tempDir, "kubectl-calls.log");
    const binDir = writeFakes(tempDir, dockerCalls, k3sCalls, kubectlCalls, { deploymentExists: false });

    const result = runImport(importArgs(binDir), binDir);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readCalls(kubectlCalls), [`${kubectlGlobals(binDir)} get ${apiDeployment} --ignore-not-found -o name`]);
  });

  it("fails before import when either required local Docker dev image is unavailable", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-dev-images-missing-image-"));
    const dockerCalls = path.join(tempDir, "docker-calls.log");
    const k3sCalls = path.join(tempDir, "k3s-calls.log");
    const kubectlCalls = path.join(tempDir, "kubectl-calls.log");
    const binDir = writeFakes(tempDir, dockerCalls, k3sCalls, kubectlCalls, { missingImage: runnerImage });

    const result = runImport(importArgs(binDir), binDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`local Docker image is required: ${escapeRegExp(runnerImage)}`));
    assert.deepEqual(readCalls(dockerCalls), [`image inspect ${appImage}`, `image inspect ${runnerImage}`]);
    assert.deepEqual(readCalls(k3sCalls), []);
    assert.deepEqual(readCalls(kubectlCalls), []);
  });

  it("stops before import and restart when Docker cannot save an image", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-dev-images-save-failure-"));
    const dockerCalls = path.join(tempDir, "docker-calls.log");
    const k3sCalls = path.join(tempDir, "k3s-calls.log");
    const kubectlCalls = path.join(tempDir, "kubectl-calls.log");
    const binDir = writeFakes(tempDir, dockerCalls, k3sCalls, kubectlCalls, { failSaveImage: appImage });

    const result = runImport(importArgs(binDir), binDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`failed to import local Docker image into k3s containerd: ${escapeRegExp(appImage)}`));
    assert.deepEqual(readCalls(dockerCalls), [
      `image inspect ${appImage}`,
      `image inspect ${runnerImage}`,
      `image save ${appImage}`
    ]);
    assert.deepEqual(readCalls(k3sCalls), ["ctr -n k8s.io images import -"]);
    assert.deepEqual(readCalls(kubectlCalls), []);
  });

  it("stops before restart when k3s containerd rejects an image import", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-dev-images-import-failure-"));
    const dockerCalls = path.join(tempDir, "docker-calls.log");
    const k3sCalls = path.join(tempDir, "k3s-calls.log");
    const kubectlCalls = path.join(tempDir, "kubectl-calls.log");
    const binDir = writeFakes(tempDir, dockerCalls, k3sCalls, kubectlCalls, { failImportImage: appImage });

    const result = runImport(importArgs(binDir), binDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`failed to import local Docker image into k3s containerd: ${escapeRegExp(appImage)}`));
    assert.deepEqual(readCalls(dockerCalls), [
      `image inspect ${appImage}`,
      `image inspect ${runnerImage}`,
      `image save ${appImage}`
    ]);
    assert.deepEqual(readCalls(k3sCalls), ["ctr -n k8s.io images import -"]);
    assert.deepEqual(readCalls(kubectlCalls), []);
  });

  it("requires explicit executable k3s and kubectl binaries plus a namespace before invoking Docker", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-dev-images-k3s-"));
    const dockerCalls = path.join(tempDir, "docker-calls.log");
    const k3sCalls = path.join(tempDir, "k3s-calls.log");
    const kubectlCalls = path.join(tempDir, "kubectl-calls.log");
    const binDir = writeFakes(tempDir, dockerCalls, k3sCalls, kubectlCalls);

    const result = runImport([], binDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--k3s-bin is required/);
    assert.deepEqual(readCalls(dockerCalls), []);
    assert.deepEqual(readCalls(k3sCalls), []);
    assert.deepEqual(readCalls(kubectlCalls), []);
  });

  it("requires the substrate kubeconfig and kube context before invoking Docker", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-import-dev-images-kube-target-"));
    const dockerCalls = path.join(tempDir, "docker-calls.log");
    const k3sCalls = path.join(tempDir, "k3s-calls.log");
    const kubectlCalls = path.join(tempDir, "kubectl-calls.log");
    const binDir = writeFakes(tempDir, dockerCalls, k3sCalls, kubectlCalls);
    const withoutKubeconfig = importArgs(binDir).filter((arg, index, values) => arg !== "--kubeconfig" && values[index - 1] !== "--kubeconfig");

    const missingKubeconfig = runImport(withoutKubeconfig, binDir);

    assert.notEqual(missingKubeconfig.status, 0);
    assert.match(missingKubeconfig.stderr, /--kubeconfig is required/);
    const withoutKubeContext = importArgs(binDir).filter((arg, index, values) => arg !== "--kube-context" && values[index - 1] !== "--kube-context");
    const missingKubeContext = runImport(withoutKubeContext, binDir);

    assert.notEqual(missingKubeContext.status, 0);
    assert.match(missingKubeContext.stderr, /--kube-context is required/);
    assert.deepEqual(readCalls(dockerCalls), []);
    assert.deepEqual(readCalls(k3sCalls), []);
    assert.deepEqual(readCalls(kubectlCalls), []);
  });
});

function runImport(args: string[], binDir: string) {
  return spawnSync("bash", ["scripts/deploy/import-dev-images.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  });
}

function importArgs(binDir: string): string[] {
  return [
    "--k3s-bin",
    path.join(binDir, "k3s"),
    "--kubectl-bin",
    path.join(binDir, "kubectl"),
    "--kubeconfig",
    path.join(binDir, "substrate.kubeconfig"),
    "--kube-context",
    kubeContext,
    "--namespace",
    namespace
  ];
}

function kubectlGlobals(binDir: string): string {
  return `--kubeconfig ${path.join(binDir, "substrate.kubeconfig")} --context ${kubeContext} --namespace ${namespace}`;
}

function writeFakes(
  tempDir: string,
  dockerCalls: string,
  k3sCalls: string,
  kubectlCalls: string,
  options: { missingImage?: string; failSaveImage?: string; failImportImage?: string; deploymentExists?: boolean } = {}
): string {
  const binDir = path.join(tempDir, "bin");
  const docker = path.join(binDir, "docker");
  const k3s = path.join(binDir, "k3s");
  const kubectl = path.join(binDir, "kubectl");
  writeFileSync(dockerCalls, "");
  writeFileSync(k3sCalls, "");
  writeFileSync(kubectlCalls, "");
  mkdirSync(binDir);
  writeFileSync(path.join(binDir, "substrate.kubeconfig"), "apiVersion: v1\nkind: Config\n");
  writeFileSync(docker, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${dockerCalls}"
if [ "$1" = image ] && [ "$2" = inspect ] && [ "${options.missingImage ?? ""}" = "$3" ]; then
  echo "No such image: $3" >&2
  exit 1
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  exit 0
fi
if [ "$1" = image ] && [ "$2" = save ]; then
  if [ "${options.failSaveImage ?? ""}" = "$3" ]; then
    echo "failed to save $3" >&2
    exit 1
  fi
  printf 'docker archive for %s\\n' "$3"
  exit 0
fi
echo "unexpected fake Docker args: $*" >&2
exit 9
`);
  writeFileSync(k3s, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${k3sCalls}"
[ "$*" = "ctr -n k8s.io images import -" ]
cat >/dev/null
[ "${options.failImportImage ?? ""}" != "${appImage}" ] || exit 1
`);
  writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${kubectlCalls}"
if [ "$*" = "${kubectlGlobals(binDir)} get ${apiDeployment} --ignore-not-found -o name" ]; then
  [ "${options.deploymentExists !== false}" = true ] && printf 'deployment.apps/agentsmith-lite-api\\n'
  exit 0
fi
[ "$*" = "${kubectlGlobals(binDir)} rollout restart ${apiDeployment}" ]
`);
  chmodSync(docker, 0o755);
  chmodSync(k3s, 0o755);
  chmodSync(kubectl, 0o755);
  return binDir;
}

function readCalls(callsFile: string): string[] {
  const calls = readFileSync(callsFile, "utf8").trim();
  return calls ? calls.split("\n") : [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
