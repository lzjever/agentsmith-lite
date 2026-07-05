import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const appDigestRef = "agentsmith-lite/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const runnerDigestRef = "agentsmith-lite/botified-runner@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const otherAppDigestRef = "agentsmith-lite/app@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const validAppSessionSecret = "app-session-secret-at-least-32-chars";

describe("deploy preflight", () => {
  it("does not call kubectl even when kube connection settings are present", () => {
    const fixture = writePreflightFixture({
      extraEnv: [
        "KUBECONFIG_PATH=/tmp/agentsmith.kubeconfig",
        "KUBE_CONTEXT=kind-agentsmith",
        "JUICEFS_PVC_NAME=agentsmith-lite-juicefs"
      ]
    });
    const fakeKubectl = writeFailingKubectl(fixture.tempDir);

    const result = runPreflight(fixture, [], {
      PATH: `${fixture.tempDir}:${process.env.PATH ?? ""}`,
      FAKE_KUBECTL_CALLS: fakeKubectl.callsFile
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(fakeKubectl.callsFile), false);
  });

  it("fails env and app overlay contract errors without leaking values", () => {
    const cases: Array<{
      name: string;
      mutate: (fixture: PreflightFixture) => void;
      error: RegExp;
      leakedValue: RegExp;
    }> = [
      {
        name: "app key in substrate env",
        mutate: (fixture) => {
          writeFileSync(fixture.envFile, `${readFileSync(fixture.envFile, "utf8")}AGENTSMITH_LITE_SANDBOX_MODE=DO_NOT_PRINT_SUBSTRATE_VALUE\n`);
        },
        error: /AGENTSMITH_LITE_SANDBOX_MODE/,
        leakedValue: /DO_NOT_PRINT_SUBSTRATE_VALUE/
      },
      {
        name: "unknown app overlay key",
        mutate: (fixture) => {
          writeFileSync(fixture.appEnvFile, "NOT_APP_OVERLAY=DO_NOT_PRINT_APP_OVERLAY_VALUE\n");
        },
        error: /NOT_APP_OVERLAY/,
        leakedValue: /DO_NOT_PRINT_APP_OVERLAY_VALUE/
      }
    ];

    for (const candidate of cases) {
      const fixture = writePreflightFixture();
      candidate.mutate(fixture);

      const result = runPreflight(fixture);

      assert.notEqual(result.status, 0, candidate.name);
      assert.match(result.stderr, candidate.error, candidate.name);
      assert.doesNotMatch(result.stderr + result.stdout, candidate.leakedValue, candidate.name);
    }
  });

  it("fails unknown arguments", () => {
    const fixture = writePreflightFixture();

    const result = runPreflight(fixture, ["--wat"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument: --wat/);
  });

  it("keeps bundle and images.lock validation wired through preflight", () => {
    const fixture = writePreflightFixture();
    const lockFile = path.join(fixture.tempDir, "mismatched-images.lock");
    writeFileSync(lockFile, `${otherAppDigestRef}\n${runnerDigestRef}\n`);

    const result = runPreflight(fixture, ["--bundle", fixture.bundleDir, "--images-lock", lockFile]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /images\.lock|bundle|digest|match/i);
  });
});

function runPreflight(fixture: PreflightFixture, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [
    "scripts/deploy/preflight.sh",
    "--env",
    fixture.envFile,
    "--secrets",
    fixture.secretsFile,
    "--app-env",
    fixture.appEnvFile,
    "--out",
    fixture.outDir,
    ...args
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      KUBECONFIG_PATH: "",
      KUBE_CONTEXT: "",
      ...env
    }
  });
}

function writePreflightFixture(options: Partial<PreflightFixtureOptions> = {}): PreflightFixture {
  const tempDir = mkdtempSync(path.join(tmpdir(), "agentsmith-lite-preflight-"));
  const envFile = path.join(tempDir, "substrate.env");
  const secretsFile = path.join(tempDir, "substrate.secrets.env");
  const appEnvFile = path.join(tempDir, "app.env");
  const outDir = path.join(tempDir, "manifests");
  const bundleDir = path.join(tempDir, "bundle");

  writeFileSync(envFile, ["KUBE_NAMESPACE=agentsmith", ...(options.extraEnv ?? []), ""].join("\n"));
  writeFileSync(appEnvFile, "\n");
  writeFileSync(
    secretsFile,
    [
      "POSTGRES_APP_URL=postgres://app",
      `APP_SESSION_SECRET=${validAppSessionSecret}`,
      "BUILTIN_ADMIN_INITIAL_PASSWORD=admin-secret",
      ""
    ].join("\n")
  );
  writeManifests(outDir);
  writeBundle(bundleDir);

  return { tempDir, envFile, secretsFile, appEnvFile, outDir, bundleDir };
}

function writeManifests(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "all.yaml"),
    `apiVersion: apps/v1
kind: Deployment
metadata:
  name: agentsmith-lite-api
spec:
  template:
    spec:
      containers:
        - name: api
          image: ${appDigestRef}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: agentsmith-lite-schema-bootstrap
spec:
  template:
    spec:
      containers:
        - name: schema-bootstrap
          image: ${appDigestRef}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: agentsmith-lite-config
data:
  BOTIFIED_RUNNER_IMAGE: ${runnerDigestRef}
---
apiVersion: v1
kind: Secret
metadata:
  name: agentsmith-lite-app-secrets
stringData:
  BUILTIN_ADMIN_INITIAL_PASSWORD: admin-secret
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: agentsmith-lite-api-sandbox
rules:
  - resources:
      - pods
    verbs:
      - create
      - get
      - list
`
  );
}

function writeBundle(bundleDir: string): void {
  const files: Record<string, string> = {
    "manifest.yaml": `schema: agentsmith-lite.app-offline-bundle/v1
images:
  - name: agentsmith-lite/app
    ref: ${appDigestRef}
    archive: images/app.tar
  - name: agentsmith-lite/botified-runner
    ref: ${runnerDigestRef}
    archive: images/botified-runner.tar
`,
    "images.lock": `${appDigestRef}\n${runnerDigestRef}\n`,
    "images/app.tar": "app archive\n",
    "images/botified-runner.tar": "runner archive\n"
  };

  for (const [relativePath, contents] of Object.entries(files)) {
    const file = path.join(bundleDir, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }

  const checksums = Object.keys(files)
    .map((relativePath) => `${sha256File(path.join(bundleDir, relativePath))}  ${relativePath}`)
    .join("\n");
  writeFileSync(path.join(bundleDir, "checksums.txt"), `${checksums}\n`);
}

function writeFailingKubectl(tempDir: string): { callsFile: string } {
  const fakeKubectl = path.join(tempDir, "kubectl");
  const callsFile = path.join(tempDir, "kubectl-calls.txt");
  writeFileSync(
    fakeKubectl,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_KUBECTL_CALLS"
exit 42
`
  );
  chmodSync(fakeKubectl, 0o755);
  return { callsFile };
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

interface PreflightFixture {
  tempDir: string;
  envFile: string;
  secretsFile: string;
  appEnvFile: string;
  outDir: string;
  bundleDir: string;
}

interface PreflightFixtureOptions {
  extraEnv?: string[] | undefined;
}
