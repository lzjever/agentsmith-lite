import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
      env: {
        APP_PUBLIC_BASE_URL: "https://agentsmith.example.test/",
        AUTH_MODE: "oidc",
        OIDC_ISSUER_URL: "https://keycloak.example.test/realms/agentsmith",
        OIDC_CLIENT_ID: "agentsmith-lite"
      },
      secrets: { OIDC_CLIENT_SECRET: "oidc-client-secret" },
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
    assert.equal(configMap?.data.APP_PUBLIC_BASE_URL, "https://agentsmith.example.test/");
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
      const secretsFile = path.join(tempDir, "substrate.secrets.env");
      const lockFile = path.join(tempDir, "images.lock");
      const outDir = path.join(tempDir, "manifests");
      writeRenderEnv(envFile, secretsFile, "https://agentsmith.example.test/");
      writeFileSync(lockFile, candidate.lock);

      const result = spawnSync(
        "bash",
        ["scripts/deploy/render.sh", "--env", envFile, "--secrets", secretsFile, "--images-lock", lockFile, "--out", outDir, "--tag", "dev"],
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
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const lockFile = path.join(tempDir, "images.lock");
    const outDir = path.join(tempDir, "manifests");
    writeRenderEnv(envFile, secretsFile, "https://agentsmith.example.test/app");
    writeFileSync(lockFile, `${appDigestRef}\n${runnerDigestRef}\n`);

    const result = spawnSync(
      "bash",
      ["scripts/deploy/render.sh", "--env", envFile, "--secrets", secretsFile, "--images-lock", lockFile, "--out", outDir, "--tag", "dev"],
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
    assert.match(manifest, /APP_PUBLIC_BASE_URL: "https:\/\/agentsmith\.example\.test\/app"/);
    assert.match(manifest, /path: "\/app"/);
    assert.match(manifest, /path: "\/app\/health"/);
  });

  it("render.sh writes an app Ingress manifest into per-resource output and all.yaml", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-ingress-render-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const outDir = path.join(tempDir, "manifests");
    writeFileSync(
      envFile,
      [
        "export KUBE_NAMESPACE='agentsmith-preview'",
        "APP_PUBLIC_BASE_URL=\"https://agentsmith.example.com/app\"",
        "export APP_INGRESS_CLASS='nginx'",
        "APP_TLS_SECRET_NAME=\"agentsmith-lite-tls\"",
        "AUTH_MODE=oidc",
        "OIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith",
        "OIDC_CLIENT_ID=agentsmith-lite",
        ""
      ].join("\n")
    );
    writeFileSync(secretsFile, "export POSTGRES_APP_URL='postgres://app'\nAPP_SESSION_SECRET=\"app-session-secret-at-least-32-chars\"\nOIDC_CLIENT_SECRET=oidc-client-secret\n");

    const result = spawnSync("bash", ["scripts/deploy/render.sh", "--env", envFile, "--secrets", secretsFile, "--out", outDir, "--tag", "dev"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const files = readdirSync(outDir);
    const ingressFile = files.find((file) => /-ingress-agentsmith-lite-api\.yaml$/.test(file));
    assert.ok(ingressFile, `expected per-resource Ingress manifest in ${files.join(", ")}`);

    const allManifest = readFileSync(path.join(outDir, "all.yaml"), "utf8");
    const ingressManifest = readFileSync(path.join(outDir, ingressFile), "utf8");
    for (const manifest of [allManifest, ingressManifest]) {
      assert.match(manifest, /kind: "Ingress"/);
      assert.match(manifest, /namespace: "agentsmith-preview"/);
      assert.match(manifest, /host: "agentsmith\.example\.com"/);
      assert.match(manifest, /path: "\/app"/);
      assert.match(manifest, /ingressClassName: "nginx"/);
      assert.match(manifest, /secretName: "agentsmith-lite-tls"/);
      assert.match(manifest, /name: "agentsmith-lite-api"/);
      assert.match(manifest, /name: "http"/);
    }
  });

  it("render.sh accepts generated substrate env/secrets files plus app overlay and keeps substrate-only values out of manifests", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-generated-substrate-render-"));
    const envFile = path.join(tempDir, "substrate.env");
    const secretsFile = path.join(tempDir, "substrate.secrets.env");
    const appEnvFile = path.join(tempDir, "app.env");
    const appSecretsFile = path.join(tempDir, "app.secrets.env");
    const outDir = path.join(tempDir, "manifests");
    writeGeneratedSubstrateFiles(envFile, secretsFile);
    writeFileSync(
      appEnvFile,
      [
        "AGENTSMITH_LITE_SANDBOX_MODE=live",
        ""
      ].join("\n")
    );
    writeFileSync(appSecretsFile, "APP_CREDENTIAL_ENCRYPTION_KEY=app-credential-key\n");

    const result = spawnSync("bash", [
      "scripts/deploy/render.sh",
      "--env",
      envFile,
      "--secrets",
      secretsFile,
      "--app-env",
      appEnvFile,
      "--app-secrets",
      appSecretsFile,
      "--out",
      outDir,
      "--tag",
      "dev"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const manifest = readFileSync(path.join(outDir, "all.yaml"), "utf8");
    assert.match(manifest, /namespace: "agentsmith-preview"/);
    assert.match(manifest, /JUICEFS_PVC_NAME: "agentsmith-lite-files"/);
    assert.match(manifest, /kind: "Ingress"/);
    assert.match(manifest, /ingressClassName: "nginx"/);
    assert.match(manifest, /secretName: "agentsmith-lite-tls"/);
    assert.match(manifest, /AGENTSMITH_LITE_SANDBOX_MODE: "live"/);
    assert.match(manifest, /BOTIFIED_RUNNER_IMAGE: "agentsmith-lite\/botified-runner:dev"/);
    assert.doesNotMatch(manifest, /registry\.example\.test\/agentsmith\/botified-runner/);
    assert.match(manifest, /APP_CREDENTIAL_ENCRYPTION_KEY: "app-credential-key"/);
    assert.match(manifest, /POSTGRES_APP_URL: "postgresql:\/\/app:secret@db\/agentsmith"/);
    assert.match(manifest, /AUTH_MODE: "oidc"/);
    assert.match(manifest, /OIDC_CLIENT_SECRET: "oidc-client-secret"/);
    assert.match(manifest, /OIDC_ISSUER_URL: "https:\/\/keycloak\.example\.test\/realms\/agentsmith"/);
    assert.match(manifest, /OIDC_CLIENT_ID: "agentsmith-lite"/);
    assert.doesNotMatch(manifest + result.stdout + result.stderr, /DO_NOT_PRINT/);
  });

  it("render.sh fails closed on unknown env typos without leaking values", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-render-env-typo-"));
    const envFile = path.join(tempDir, "substrate.env");
    const outDir = path.join(tempDir, "manifests");
    writeFileSync(envFile, "KUBE_NAMESPCE=DO_NOT_PRINT_NAMESPACE_TYPO\n");

    const result = spawnSync("bash", ["scripts/deploy/render.sh", "--env", envFile, "--out", outDir, "--tag", "dev"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /KUBE_NAMESPCE/);
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT_NAMESPACE_TYPO/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeRenderEnv(envFile: string, secretsFile: string, publicBaseUrl: string): void {
  writeFileSync(envFile, [
    "KUBE_NAMESPACE=agentsmith",
    `APP_PUBLIC_BASE_URL=${publicBaseUrl}`,
    "AUTH_MODE=oidc",
    "OIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith",
    "OIDC_CLIENT_ID=agentsmith-lite"
  ].join("\n") + "\n");
  writeFileSync(secretsFile, "OIDC_CLIENT_SECRET=oidc-client-secret\n");
}

function writeGeneratedSubstrateFiles(envFile: string, secretsFile: string): void {
  writeFileSync(
    envFile,
    [
      "SUBSTRATE_SCHEMA_VERSION=DO_NOT_PRINT_SCHEMA_VERSION_ENV",
      "KUBECONFIG_PATH=/tmp/agentsmith.kubeconfig",
      "KUBE_CONTEXT=kind-agentsmith",
      "KUBE_NAMESPACE=agentsmith-preview",
      "S3_ENDPOINT=DO_NOT_PRINT_S3_ENDPOINT",
      "S3_REGION=DO_NOT_PRINT_S3_REGION",
      "S3_BUCKET=DO_NOT_PRINT_S3_BUCKET",
      "S3_FORCE_PATH_STYLE=DO_NOT_PRINT_S3_FORCE_PATH_STYLE",
      "AUTH_MODE=oidc",
      "OIDC_ISSUER_URL=https://keycloak.example.test/realms/agentsmith",
      "OIDC_CLIENT_ID=agentsmith-lite",
      "JUICEFS_VOLUME_NAME=DO_NOT_PRINT_JUICEFS_VOLUME_NAME",
      "JUICEFS_BUCKET=DO_NOT_PRINT_JUICEFS_BUCKET",
      "JUICEFS_SECRET_NAME=DO_NOT_PRINT_JUICEFS_SECRET_NAME",
      "JUICEFS_CSI_DRIVER=DO_NOT_PRINT_JUICEFS_CSI_DRIVER",
      "JUICEFS_STORAGE_CLASS=DO_NOT_PRINT_JUICEFS_STORAGE_CLASS",
      "JUICEFS_PVC_NAME=agentsmith-lite-files",
      "JUICEFS_MOUNT_ROOT=DO_NOT_PRINT_JUICEFS_MOUNT_ROOT",
      "APP_PUBLIC_BASE_URL=https://agentsmith.example.test/app",
      "APP_INGRESS_CLASS=nginx",
      "APP_TLS_SECRET_NAME=agentsmith-lite-tls",
      "REGISTRY_URL=DO_NOT_PRINT_REGISTRY_URL",
      "IMAGE_PULL_SECRET_NAME=DO_NOT_PRINT_IMAGE_PULL_SECRET_NAME",
      ""
    ].join("\n")
  );
  writeFileSync(
    secretsFile,
    [
      "SUBSTRATE_SCHEMA_VERSION=DO_NOT_PRINT_SCHEMA_VERSION_SECRETS",
      "POSTGRES_APP_URL=postgresql://app:secret@db/agentsmith",
      "APP_SESSION_SECRET=app-session-secret-at-least-32-chars",
      "S3_ACCESS_KEY=DO_NOT_PRINT_S3_ACCESS_KEY",
      "S3_SECRET_KEY=DO_NOT_PRINT_S3_SECRET_KEY",
      "JUICEFS_META_URL=DO_NOT_PRINT_JUICEFS_META_URL",
      "OIDC_CLIENT_SECRET=oidc-client-secret",
      ""
    ].join("\n")
  );
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
