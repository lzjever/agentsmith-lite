import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { renderAppManifests } from "../../packages/sandbox-controller/src/appManifestRenderer.js";

const appDigestRef = "agentsmith-lite/app@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const runnerDigestRef = "agentsmith-lite/botified-runner@sha256:2222222222222222222222222222222222222222222222222222222222222222";

describe("deploy app images.lock", () => {
  it("renders app manifests with digest-pinned app and runner image refs", () => {
    const input = {
      namespace: "agentsmith",
      imageTag: "dev",
      env: {},
      secrets: {},
      imageRefs: {
        app: appDigestRef,
        botifiedRunner: runnerDigestRef
      }
    } as Parameters<typeof renderAppManifests>[0] & {
      imageRefs: {
        app: string;
        botifiedRunner: string;
      };
    };

    const manifests = renderAppManifests(input);
    const deployment = manifests.find((manifest) => manifest.kind === "Deployment" && manifest.metadata.name === "agentsmith-lite-api") as
      | DeploymentResource
      | undefined;
    const job = manifests.find((manifest) => manifest.kind === "Job" && manifest.metadata.name === "agentsmith-lite-schema-bootstrap") as
      | JobResource
      | undefined;
    const configMap = manifests.find((manifest) => manifest.kind === "ConfigMap" && manifest.metadata.name === "agentsmith-lite-config") as
      | ConfigMapResource
      | undefined;

    assert.equal(deployment?.spec.template.spec.containers[0]?.image, appDigestRef);
    assert.equal(job?.spec.template.spec.containers[0]?.image, appDigestRef);
    assert.equal(configMap?.data.BOTIFIED_RUNNER_IMAGE, runnerDigestRef);
  });

  it("rejects images.lock files missing app or runner refs, duplicates, mutable tags, or invalid digests", () => {
    const cases = [
      {
        name: "missing runner",
        lock: `${appDigestRef}\n`
      },
      {
        name: "duplicate app",
        lock: `${appDigestRef}\n${appDigestRef}\n${runnerDigestRef}\n`
      },
      {
        name: "mutable app tag",
        lock: `agentsmith-lite/app:dev\n${runnerDigestRef}\n`
      },
      {
        name: "invalid digest",
        lock: "agentsmith-lite/app@sha256:not-a-digest\n" + `${runnerDigestRef}\n`
      }
    ];

    for (const candidate of cases) {
      const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-image-lock-invalid-"));
      const envFile = path.join(tempDir, "substrate.env");
      const lockFile = path.join(tempDir, "images.lock");
      const outDir = path.join(tempDir, "manifests");
      writeFileSync(envFile, "KUBE_NAMESPACE=agentsmith\n");
      writeFileSync(lockFile, candidate.lock);

      const result = spawnSync(
        "bash",
        ["scripts/deploy/render.sh", "--env", envFile, "--images-lock", lockFile, "--out", outDir, "--tag", "dev"],
        {
          cwd: process.cwd(),
          encoding: "utf8"
        }
      );

      assert.notEqual(result.status, 0, candidate.name);
      assert.match(result.stderr, /images\.lock|digest|duplicate|missing|mutable/i, candidate.name);
    }
  });

  it("render.sh --images-lock writes digest-pinned manifests without dev image tags", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-image-lock-render-"));
    const envFile = path.join(tempDir, "substrate.env");
    const lockFile = path.join(tempDir, "images.lock");
    const outDir = path.join(tempDir, "manifests");
    writeFileSync(envFile, "KUBE_NAMESPACE=agentsmith\n");
    writeFileSync(lockFile, `${appDigestRef}\n${runnerDigestRef}\n`);

    const result = spawnSync(
      "bash",
      ["scripts/deploy/render.sh", "--env", envFile, "--images-lock", lockFile, "--out", outDir, "--tag", "dev"],
      {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const manifest = readFileSync(path.join(outDir, "all.yaml"), "utf8");
    assert.match(manifest, new RegExp(escapeRegExp(appDigestRef)));
    assert.match(manifest, new RegExp(escapeRegExp(runnerDigestRef)));
    assert.doesNotMatch(manifest, /agentsmith-lite\/app:dev/);
    assert.doesNotMatch(manifest, /agentsmith-lite\/botified-runner:dev/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ConfigMapResource {
  kind: "ConfigMap";
  data: Record<string, string>;
}

interface DeploymentResource {
  kind: "Deployment";
  spec: {
    template: {
      spec: {
        containers: Array<{
          image: string;
        }>;
      };
    };
  };
}

interface JobResource {
  kind: "Job";
  spec: {
    template: {
      spec: {
        containers: Array<{
          image: string;
        }>;
      };
    };
  };
}
